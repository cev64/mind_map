// Shared auth for the internal webhook functions (`embed`, `link`): the caller sends header
// x-mind-webhook-secret, checked against mind.internal_config.webhook_secret (service role only).
// The secret lives only in the database, so it never needs to be copied into an Edge Function secret.
import type { createAdminClient } from "./supabaseAdmin.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface InternalConfig {
  webhookSecret: string | null;
  functionsUrl: string | null;
}

// Constant-time comparison: hash both sides to equal length, then XOR-accumulate.
export async function secretsMatch(a: string, b: string): Promise<boolean> {
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

let cached: InternalConfig | null = null;

/** Loads webhook_secret and functions_url once per isolate. */
export async function internalConfig(db: AdminClient): Promise<InternalConfig> {
  if (cached?.webhookSecret) return cached;
  const { data, error } = await db
    .from("internal_config")
    .select("key, value")
    .in("key", ["webhook_secret", "functions_url"]);
  if (error) throw new Error(`load internal_config: ${error.message}`);
  const byKey = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  cached = {
    webhookSecret: byKey.get("webhook_secret") ?? null,
    functionsUrl: byKey.get("functions_url") ?? null,
  };
  return cached;
}

/**
 * Returns null when the request carries the right secret, else the Response to send back
 * (500 if the secret isn't configured, 401 if it doesn't match).
 */
export async function checkWebhookSecret(
  req: Request,
  db: AdminClient,
  fn: string,
): Promise<{ config: InternalConfig; reject: null } | { config: null; reject: Response }> {
  let config: InternalConfig;
  try {
    config = await internalConfig(db);
  } catch (e) {
    console.error(`${fn}:`, e instanceof Error ? e.message : String(e));
    return { config: null, reject: Response.json({ error: "server misconfigured" }, { status: 500 }) };
  }
  if (!config.webhookSecret) {
    console.error(`${fn}: mind.internal_config has no webhook_secret; refusing all requests`);
    return { config: null, reject: Response.json({ error: "server misconfigured" }, { status: 500 }) };
  }
  const provided = req.headers.get("x-mind-webhook-secret") ?? "";
  if (!(await secretsMatch(provided, config.webhookSecret))) {
    return { config: null, reject: Response.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { config, reject: null };
}
