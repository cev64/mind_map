// Phase 0 smoke test: proves the Edge Runtime serves functions locally and on deploy.
import "@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => Response.json({ ok: true, service: "mind-map" }));
