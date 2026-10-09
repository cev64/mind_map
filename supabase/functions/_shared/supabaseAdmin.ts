// Service-role client for the `mind` schema. Bypasses RLS: only `embed`, `link` and `reflect`
// may import this (plan section 9). User-facing functions must use the caller's JWT instead.
import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "mind" }, auth: { persistSession: false } },
  );
}
