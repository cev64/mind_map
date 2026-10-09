# Progress

## Current phase
**Phase 1 — Data layer**: complete (local + remote), waiting for Charlie's "continue" to start Phase 2 (chat brain). Phase 0 complete: placeholder live at https://cev64.github.io/mind_map/.

## Done
- Vite 8 + React 19 + TypeScript + Tailwind v4 scaffold. Hash routing (`createHashRouter`, react-router 8).
- Design tokens from `STYLE.md` in `src/styles/tokens.css` (light + dark), glass recipes and ambient backdrop in `src/index.css`. Inter + Barlow Condensed bundled locally via `@fontsource`.
- Placeholder home page (shows whether Supabase env is configured).
- `.gitignore` (ignores `.env*` except `.env.example`), `.env.example`.
- `supabase/` initialised (CLI as a dev dependency, run with `npx supabase`). Local config allows `localhost:5173/mind_map/` + the Pages URL as auth redirects.
- `hello` Edge Function (health check) for the Phase 0 serve check.
- `.github/workflows/deploy.yml`: lint, build, deploy to Pages on push to `main`.
- Subagents in `.claude/agents/`: researcher, db-engineer, functions-engineer, frontend-engineer, reviewer.
- Phase 1: migration `supabase/migrations/20261009220918_mind_schema.sql` (plan section 3 in full: enums, 10 tables incl. `internal_config`, RLS on all, grants for `authenticated`/`service_role` only, triggers, HNSW + FK indexes, 5 RPCs, realtime publication). `embed` Edge Function (+ `_shared/embed.ts`, `_shared/supabaseAdmin.ts`). Local `supabase/seed.sql` with 2 test users and 17 generic nodes / 12 edges.
- Phase 1 remote (2026-10-09, via connector, approved by Charlie): migrations `mind_schema` + `mind_expose_schema` applied; `internal_config` rows inserted (secret generated in SQL); `embed` deployed (verify_jwt=false). Verified: test node under Charlie's user embedded via trigger (384 dims, norm 1.0, HTTP 200); match_nodes/get_neighborhood work under RLS as Charlie; `authenticated` denied on internal_config; unauthenticated embed call → 401. Advisors: only INFO for `mind` (internal_config has no policies by design; new indexes unused).

## Decisions
- **Repo is `cev64/mind_map` (underscore), confirmed by Charlie; CLAUDE.md and the plan updated.** Pages URL is therefore `https://cev64.github.io/mind_map/`. Vite `base` defaults to `/mind_map/`; CI sets it from the repo name, so a rename to `mind-map` needs no code change.
- **Auth site URL (confirmed by Charlie):** the Budget project's Site URL is shared with the budget app, so we do **not** change it. We only add our URLs to the redirect allow-list and pass `emailRedirectTo` from the app.
- Project URL and publishable key were read from the Supabase project (both public); `.env.local` exists locally and is git-ignored.
- **Remote Supabase changes go through the Supabase connector** (confirmed by Charlie), not the CLI: no access token or DB password needed. Migrations are still files in `supabase/migrations/`, tested on the local stack first, SQL shown to Charlie before applying.
- GitHub: `main` is the default branch; the `github-pages` environment allows deploys from `main`. The session's GitHub integration can't re-run or dispatch workflows, so a deploy is triggered by pushing to `main`.
- Embed webhook: AFTER INSERT / UPDATE OF kind,title,body trigger → `net.http_post` to `{functions_url}/embed` with header `x-mind-webhook-secret`. `functions_url` and `webhook_secret` live in `mind.internal_config` (RLS on, no policies, no grants to API roles) rather than Vault, to keep everything in `mind`. The function reads the same secret from `internal_config` (service role) and compares it in constant time, so the secret exists only in the database: on remote it's generated in SQL and never seen by anyone. Writes are guarded by `nodes.content_updated_at` (bumped only by kind/title/body edits) so an older run can't overwrite a newer edit.
- Additions beyond the plan's table sketch: `edges.meta` (5b needs it), `edges.created_by` check, `nodes.embedding_source_hash` (skip unchanged text), `mind.internal_config`, `on delete cascade` from `auth.users`. `nodes.updated_at` is bumped only by content changes, never by embedding writes (keeps link_checks freshness correct).
- **Shared project:** the Budget project also hosts `betting` and `claudehub` schemas, exposed via `alter role authenticator set pgrst.db_schemas`. Migration `20261009230000_mind_expose_schema.sql` appends `mind` to that list (no-op locally).
- Every new function in `mind` must `revoke execute ... from public, anon` explicitly.
- After applying a migration remotely, run `notify pgrst, 'reload schema';` — PostgREST's cache didn't pick up the new tables until then (embed got "server misconfigured").
- The connector waits for Charlie's confirmation on destructive SQL (DELETE); it times out after 60s if he isn't watching.
- PWA (`vite-plugin-pwa`) deferred to Phase 3, when there's a real app shell and icons.

## Known issues
- Remote test node `055f2fde-…` (title "Phase 1 test: …", meta.test='phase1') is marked `rejected` instead of deleted (the DELETE needed Charlie's confirmation). Delete it when convenient.
- Other apps in the shared project have advisor warnings (`public.take_net_worth_snapshot` security definer callable by signed-in users; leaked password protection off). Not ours; mentioned to Charlie.
- gte-small similarities are compressed high: unrelated sample nodes score ~0.72–0.79, related ~0.81–0.89. The plan's thresholds need tuning in Phase 2/2b: dedupe at 0.88 would wrongly merge "Learn a musical instrument" with "Should I learn piano or guitar?" (0.887); `link_candidates` min_similarity 0.55 filters nothing (k=10 still caps cost).

## Next steps
1. Charlie: test Phase 1 by hand (see checkpoint), set Edge Function secret `ANTHROPIC_API_KEY` in the dashboard, say "continue".
2. Phase 2 (chat brain): researcher checks current Claude API (model IDs, tool use, streaming, prompt caching) first; `chat` function with context building, tool loop (search_mind, open_node, capture, propose_change, branch), persistence, token-usage logging; tune dedupe threshold for gte-small (0.88 too low).

## Sandbox notes (cloud sessions only)
- The cloud container re-terminates TLS through a proxy. For `supabase functions serve` to fetch jsr/npm imports, a git-ignored `supabase/functions/.env` sets `DENO_TLS_CA_STORE=mozilla,system` and `SSL_CERT_FILE`/`DENO_CERT` to a copy of `/root/.ccr/ca-bundle.crt` in `supabase/functions/.certs/` (also git-ignored). Not needed on a normal machine.
- gte-small can't download in the sandbox (edge runtime's downloader ignores the proxy CA). `scripts/sandbox/seed-gte-cache.sh` copies the model into the runtime cache; run it right after `functions serve` starts and before any embed call, and again after every `db reset` (which recreates the container; restart serve too).
- Docker isn't running at session start: `sudo dockerd &` first, then `npx supabase start -x studio,imgproxy,vector,logflare,supavisor,postgres-meta,mailpit`.
