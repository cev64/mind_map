// `embed`: called by a Postgres trigger (pg_net) after a node is inserted or its title/body/kind changes.
// POST {"node_id": "<uuid>"} with header x-mind-webhook-secret. Writes mind.nodes.embedding (gte-small, 384d).
// The secret lives only in mind.internal_config (the trigger reads it there too), so it never needs
// to be copied into an Edge Function secret.
import "@supabase/functions-js/edge-runtime.d.ts";
import { embedText, nodeEmbeddingText, sha256Hex } from "../_shared/embed.ts";
import { createAdminClient } from "../_shared/supabaseAdmin.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Constant-time comparison: hash both sides to equal length, then XOR-accumulate.
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

let cachedSecret: string | null = null;

async function webhookSecret(db: ReturnType<typeof createAdminClient>): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  const { data, error } = await db
    .from("internal_config")
    .select("value")
    .eq("key", "webhook_secret")
    .maybeSingle();
  if (error) throw new Error(`load webhook secret: ${error.message}`);
  cachedSecret = data?.value ?? null;
  return cachedSecret;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const db = createAdminClient();
  let expected: string | null;
  try {
    expected = await webhookSecret(db);
  } catch (e) {
    console.error("embed:", e instanceof Error ? e.message : String(e));
    return json({ error: "server misconfigured" }, 500);
  }
  if (!expected) {
    console.error("embed: mind.internal_config has no webhook_secret; refusing all requests");
    return json({ error: "server misconfigured" }, 500);
  }
  const provided = req.headers.get("x-mind-webhook-secret") ?? "";
  if (!(await secretsMatch(provided, expected))) return json({ error: "unauthorized" }, 401);

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

    // PHASE 2b HOOK: after a successful write, fire-and-forget the `link` function for node.id
    // (if settings.link_suggester is on). Not implemented yet.

    return json({ status: "embedded", node_id: node.id, dims: vector.length });
  } catch (e) {
    console.error("embed failed:", e instanceof Error ? e.message : String(e));
    return json({ error: "embed failed" }, 500);
  }
});
