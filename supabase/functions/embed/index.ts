// `embed`: called by a Postgres trigger (pg_net) after a node is inserted or its title/body/kind changes.
// POST {"node_id": "<uuid>"} with header x-mind-webhook-secret. Writes mind.nodes.embedding (gte-small, 384d).
// The secret lives only in mind.internal_config (the trigger reads it there too), so it never needs
// to be copied into an Edge Function secret. After a successful write it chains `link` (plan section 5b).
import "@supabase/functions-js/edge-runtime.d.ts";
import { embedText, nodeEmbeddingText, sha256Hex } from "../_shared/embed.ts";
import { createAdminClient } from "../_shared/supabaseAdmin.ts";
import { checkWebhookSecret, type InternalConfig } from "../_shared/webhookAuth.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Fire-and-forget POST to `link` for the version just embedded. `link` answers 202 at once and does its
// work in the background, so this only waits for the hand-off; waitUntil keeps it alive after we return.
function requestLink(config: InternalConfig, nodeId: string, version: string): void {
  if (!config.functionsUrl || !config.webhookSecret) return;
  const url = config.functionsUrl.replace(/\/+$/, "") + "/link";
  const call = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mind-webhook-secret": config.webhookSecret },
    body: JSON.stringify({ node_id: nodeId, version }),
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (res) => {
      if (!res.ok) console.error(`embed: link request for ${nodeId} returned ${res.status}`);
      await res.body?.cancel();
    })
    .catch((e) => console.error(`embed: link request for ${nodeId} failed:`, e instanceof Error ? e.message : e));
  EdgeRuntime.waitUntil(call);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const db = createAdminClient();
  const auth = await checkWebhookSecret(req, db, "embed");
  if (auth.reject) return auth.reject;

  let nodeId: unknown;
  try {
    nodeId = (await req.json())?.node_id;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (typeof nodeId !== "string" || !UUID_RE.test(nodeId)) {
    return json({ error: "node_id must be a uuid" }, 400);
  }

  try {
    const { data: node, error } = await db
      .from("nodes")
      .select("id, kind, title, body, status, content_updated_at, embedding_source_hash")
      .eq("id", nodeId)
      .maybeSingle();
    if (error) throw new Error(`load node: ${error.message}`);
    if (!node) return json({ error: "node not found" }, 404);

    if (node.status === "rejected" || node.status === "archived") {
      return json({ status: "skipped", reason: `status is ${node.status}` });
    }

    const text = nodeEmbeddingText(node);
    const hash = await sha256Hex(text);
    if (hash === node.embedding_source_hash) {
      // `chat` writes the embedding inline, so its nodes arrive here already embedded: still hand them to
      // `link`. Cheap if nothing changed: claim_link_run dedupes a version, link_candidates skips checked pairs.
      requestLink(auth.config, node.id, node.content_updated_at);
      return json({ status: "skipped", reason: "text unchanged" });
    }

    const vector = await embedText(text);

    // Race guard: a newer kind/title/body edit bumps content_updated_at (and queues its own embed),
    // so an older run can't overwrite it. Status/importance/meta edits don't affect it.
    const { data: updated, error: updErr } = await db
      .from("nodes")
      .update({ embedding: JSON.stringify(vector), embedding_source_hash: hash })
      .eq("id", node.id)
      .eq("content_updated_at", node.content_updated_at)
      .select("id");
    if (updErr) throw new Error(`write embedding: ${updErr.message}`);
    if (!updated || updated.length === 0) return json({ status: "stale", node_id: node.id });

    // Chain the link suggester for this exact version (`link` checks settings.link_suggester and debounces).
    requestLink(auth.config, node.id, node.content_updated_at);

    return json({ status: "embedded", node_id: node.id, dims: vector.length });
  } catch (e) {
    console.error("embed failed:", e instanceof Error ? e.message : String(e));
    return json({ error: "embed failed" }, 500);
  }
});
