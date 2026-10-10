// `link`: the link suggester (plan section 5b). Called by `embed` after an embedding write.
// POST {"node_id": "<uuid>", "version": "<nodes.content_updated_at>"} with header x-mind-webhook-secret.
// Answers 202 at once and does the work in the background (EdgeRuntime.waitUntil); each run is logged in
// mind.link_runs (status, counts, model, token usage). Service role is allowed here (plan section 9).
//
// Flow: debounce gate (mind.claim_link_run) -> skip rejected/archived nodes or link_suggester off ->
// mind.link_candidates -> one Haiku call -> pending edges for confident verdicts -> every judged pair
// upserted into mind.link_checks (checked_at = run start, so an edit made during the run re-checks).
import "@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "@anthropic-ai/sdk";
import { type NodeRow, UUID_RE } from "../_shared/mind.ts";
import { createAdminClient } from "../_shared/supabaseAdmin.ts";
import { checkWebhookSecret } from "../_shared/webhookAuth.ts";
import {
  DEBOUNCE_SECONDS,
  DEFAULT_SETTINGS,
  MAX_CANDIDATES,
  MAX_DEBOUNCE_WAITS,
  MIN_EDGE_CONFIDENCE,
  MIN_SIMILARITY,
} from "./config.ts";
import { judgeLinks, type Verdict } from "./judge.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Claim {
  status: "claimed" | "wait" | "superseded" | "missing";
  wait_seconds: number | null;
  run_id: number | null;
  started_at: string | null;
}

/** Waits out the debounce window (at most MAX_DEBOUNCE_WAITS times). Returns the claimed run, or null to stop. */
async function claimRun(db: AdminClient, nodeId: string, version: string): Promise<Claim | null> {
  for (let attempt = 0; attempt <= MAX_DEBOUNCE_WAITS; attempt++) {
    const { data, error } = await db.rpc("claim_link_run", {
      p_node_id: nodeId,
      p_version: version,
      p_min_interval: `${DEBOUNCE_SECONDS} seconds`,
    });
    if (error) throw new Error(`claim_link_run: ${error.message}`);
    const claim = (data as Claim[] | null)?.[0];
    if (!claim) throw new Error("claim_link_run returned nothing");
    if (claim.status === "claimed") return claim;
    if (claim.status !== "wait") {
      console.log(`link: ${nodeId} ${claim.status}; nothing to do`);
      return null;
    }
    const waitMs = Math.min(DEBOUNCE_SECONDS, Math.max(0, claim.wait_seconds ?? DEBOUNCE_SECONDS)) * 1000;
    await sleep(waitMs + 250);
  }
  console.log(`link: ${nodeId} still inside the debounce window after ${MAX_DEBOUNCE_WAITS} waits; giving up`);
  return null;
}

async function finishRun(db: AdminClient, runId: number, fields: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from("link_runs")
    .update({ ...fields, finished_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) console.error(`link: could not finish run ${runId}: ${error.message}`);
}

function edgeFor(nodeId: string, v: Verdict) {
  return v.direction === "new_to_candidate"
    ? { source_id: nodeId, target_id: v.candidateId }
    : { source_id: v.candidateId, target_id: nodeId };
}

async function runLink(db: AdminClient, nodeId: string, requestedVersion: string | null): Promise<void> {
  let version = requestedVersion;
  if (!version) {
    const { data, error } = await db.from("nodes").select("content_updated_at").eq("id", nodeId).maybeSingle();
    if (error) throw new Error(`load node version: ${error.message}`);
    if (!data) return;
    version = data.content_updated_at as string;
  }

  const claim = await claimRun(db, nodeId, version);
  if (!claim?.run_id || !claim.started_at) return;
  const runId = claim.run_id;
  const checkedAt = claim.started_at;

  try {
    const { data: node, error: nodeErr } = await db
      .from("nodes")
      .select("id, user_id, kind, title, body, status")
      .eq("id", nodeId)
      .maybeSingle();
    if (nodeErr) throw new Error(`load node: ${nodeErr.message}`);
    if (!node) return await finishRun(db, runId, { status: "skipped", error: "node deleted" });
    if (node.status === "rejected" || node.status === "archived") {
      return await finishRun(db, runId, { status: "skipped", error: `node is ${node.status}` });
    }

    const { data: settingsRow, error: setErr } = await db
      .from("settings")
      .select("auto_apply, link_suggester, link_auto_accept_confidence")
      .eq("user_id", node.user_id)
      .maybeSingle();
    if (setErr) throw new Error(`load settings: ${setErr.message}`);
    const settings = { ...DEFAULT_SETTINGS, ...(settingsRow ?? {}) };
    if (!settings.link_suggester) {
      return await finishRun(db, runId, { status: "skipped", error: "link_suggester is off" });
    }

    const { data: cands, error: candErr } = await db.rpc("link_candidates", {
      node_id: nodeId,
      k: MAX_CANDIDATES,
      min_similarity: MIN_SIMILARITY,
    });
    if (candErr) throw new Error(`link_candidates: ${candErr.message}`);
    const candidates = (cands ?? []) as NodeRow[];
    if (candidates.length === 0) {
      return await finishRun(db, runId, { status: "no_candidates", candidates: 0, edges_created: 0 });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.error("link: ANTHROPIC_API_KEY is not set (add it as an Edge Function secret)");
      return await finishRun(db, runId, {
        status: "error",
        candidates: candidates.length,
        error: "ANTHROPIC_API_KEY is not set",
      });
    }

    const result = await judgeLinks(new Anthropic({ apiKey }), node as NodeRow, candidates);
    const usage = { ...result.usage, stop_reason: result.stopReason };
    if (result.error) {
      console.error(`link: ${nodeId}: ${result.error}`);
      return await finishRun(db, runId, {
        status: "error",
        candidates: candidates.length,
        model: result.model,
        usage,
        error: result.error,
      });
    }

    // --- edges for confident, specific verdicts ---
    let linkable = result.verdicts.filter((v) => v.relation !== "none" && v.confidence >= MIN_EDGE_CONFIDENCE);
    if (linkable.length > 0) {
      // Pairs linked since the candidates were loaded (chat, or the partner's own run when several nodes were
      // saved together) keep their existing edge.
      const ids = linkable.map((v) => v.candidateId).join(",");
      const { data: existing, error: exErr } = await db
        .from("edges")
        .select("source_id, target_id")
        .or(`and(source_id.eq.${nodeId},target_id.in.(${ids})),and(target_id.eq.${nodeId},source_id.in.(${ids}))`);
      if (exErr) throw new Error(`load existing edges: ${exErr.message}`);
      const linked = new Set((existing ?? []).map((e) => (e.source_id === nodeId ? e.target_id : e.source_id)));
      linkable = linkable.filter((v) => !linked.has(v.candidateId));
    }
    let edgesCreated = 0;
    if (linkable.length > 0) {
      const rows = linkable.map((v) => ({
        user_id: node.user_id,
        ...edgeFor(nodeId, v),
        kind: v.relation,
        weight: v.confidence,
        rationale: v.rationale,
        status: settings.auto_apply && v.confidence >= settings.link_auto_accept_confidence ? "active" : "pending",
        created_by: "claude",
        meta: { source: "link_suggester", model: result.model, link_run_id: runId },
      }));
      const { data: inserted, error: edgeErr } = await db
        .from("edges")
        .upsert(rows, { onConflict: "source_id,target_id,kind", ignoreDuplicates: true })
        .select("id");
      if (edgeErr) throw new Error(`insert edges: ${edgeErr.message}`);
      edgesCreated = inserted?.length ?? 0;
    }

    // --- record every judged pair (including none) so it isn't judged again until one side changes ---
    const checks = result.verdicts.map((v) => ({
      node_a: nodeId < v.candidateId ? nodeId : v.candidateId,
      node_b: nodeId < v.candidateId ? v.candidateId : nodeId,
      result: v.relation,
      confidence: v.confidence,
      checked_at: checkedAt,
    }));
    const { error: checkErr } = await db.from("link_checks").upsert(checks, { onConflict: "node_a,node_b" });
    if (checkErr) throw new Error(`upsert link_checks: ${checkErr.message}`);

    console.log(
      `link: ${nodeId}: ${candidates.length} candidates, ${result.verdicts.length} verdicts, ${edgesCreated} edges`,
    );
    await finishRun(db, runId, {
      status: "done",
      candidates: candidates.length,
      edges_created: edgesCreated,
      model: result.model,
      usage,
    });
  } catch (e) {
    const apiErr = e instanceof Anthropic.APIError ? e : null;
    const detail = errText(e).slice(0, 500);
    console.error(`link failed for ${nodeId} (status ${apiErr?.status ?? "n/a"}):`, detail);
    await finishRun(db, runId, { status: "error", error: detail });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const db = createAdminClient();
  const auth = await checkWebhookSecret(req, db, "link");
  if (auth.reject) return auth.reject;

  let body: { node_id?: unknown; version?: unknown };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const nodeId = body.node_id;
  if (typeof nodeId !== "string" || !UUID_RE.test(nodeId)) return json({ error: "node_id must be a uuid" }, 400);
  const version = body.version;
  if (version != null && (typeof version !== "string" || Number.isNaN(Date.parse(version)))) {
    return json({ error: "version must be a timestamp" }, 400);
  }

  EdgeRuntime.waitUntil(
    runLink(db, nodeId, (version as string | undefined) ?? null).catch((e) =>
      console.error(`link failed for ${nodeId}:`, errText(e))
    ),
  );
  return json({ status: "accepted", node_id: nodeId }, 202);
});
