// Client that acts as the signed-in caller (their JWT), so RLS applies to every query.
// This is what user-facing functions (`chat`) use. Never import supabaseAdmin.ts from those.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// deno-lint-ignore no-explicit-any
export type MindClient = SupabaseClient<any, "mind", any>;

export function createUserClient(authorization: string): MindClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not set");
  return createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    db: { schema: "mind" },
    auth: { persistSession: false, autoRefreshToken: false },
    // deno-lint-ignore no-explicit-any
  }) as unknown as SupabaseClient<any, "mind", any>;
}
