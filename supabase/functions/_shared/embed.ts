// Shared embedding helpers (built-in gte-small, 384 dims). Used by `embed` and, in Phase 2, `chat`.
import "@supabase/functions-js/edge-runtime.d.ts";

export const EMBEDDING_DIMS = 384;

// Created on first use and reused per isolate. Lazy so a model-load failure
// only fails embedding, not unrelated request handling.
let session: Supabase.ai.Session | null = null;

export async function embedText(text: string): Promise<number[]> {
  session ??= new Supabase.ai.Session("gte-small");
  const out = await session.run(text, { mean_pool: true, normalize: true });
  const vec = Array.from(out as ArrayLike<number>);
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(`embedding has ${vec.length} dims, expected ${EMBEDDING_DIMS}`);
  }
  return vec;
}

export function nodeEmbeddingText(
  n: { kind: string; title: string; body: string | null },
): string {
  return `${n.kind}: ${n.title}\n${n.body ?? ""}`.trim();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
