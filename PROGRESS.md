# Progress

## Current phase
**Phase 1 — Data layer**: built and verified on the local stack; waiting for Charlie to approve applying the migration to the remote project. Phase 0 complete: placeholder live at https://cev64.github.io/mind_map/.

## Done
- Vite 8 + React 19 + TypeScript + Tailwind v4 scaffold. Hash routing (`createHashRouter`, react-router 8).
- Design tokens from `STYLE.md` in `src/styles/tokens.css` (light + dark), glass recipes and ambient backdrop in `src/index.css`. Inter + Barlow Condensed bundled locally via `@fontsource`.
- Placeholder home page (shows whether Supabase env is configured).
- `.gitignore` (ignores `.env*` except `.env.example`), `.env.example`.
- `supabase/` initialised (CLI as a dev dependency, run with `npx supabase`). Local config allows `localhost:5173/mind_map/` + the Pages URL as auth redirects.
- `hello` Edge Function (health check) for the Phase 0 serve check.
- `.github/workflows/deploy.yml`: lint, build, deploy to Pages on push to `main`.
- Subagents in `.claude/agents/`: researcher, db-engineer, functions-engineer, frontend-engineer, reviewer.
- Phase 1 (local): migration `supabase/migrations/20261009220918_mind_schema.sql` (plan section 3 in full: enums, 10 tables incl. `internal_config`, RLS on all, grants for `authenticated`/`service_role` only, triggers, HNSW + FK indexes, 5 RPCs, realtime publication). `embed` Edge Function (+ `_shared/embed.ts`, `_shared/supabaseAdmin.ts`). Local `supabase/seed.sql` with 2 test users and 17 generic nodes / 12 edges.

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
- PWA (`vite-plugin-pwa`) deferred to Phase 3, when there's a real app shell and icons.

## Known issues
- gte-small similarities are compressed high: unrelated sample nodes score ~0.72–0.79, related ~0.81–0.89. The plan's thresholds need tuning in Phase 2/2b: dedupe at 0.88 would wrongly merge "Learn a musical instrument" with "Should I learn piano or guitar?" (0.887); `link_candidates` min_similarity 0.55 filters nothing (k=10 still caps cost).

## Next steps
1. Charlie: approve the SQL summary and give the magic-link email (used to pick his auth user for the remote check).
2. Lead: apply both migrations via the connector; insert remote `internal_config` (functions_url = https://sygxozspiszqfawkmpzx.supabase.co/functions/v1, webhook_secret generated in SQL); deploy `embed` (verify_jwt=false); run advisors; verify insert → embedding on remote with a temporary node, then delete it.
3. Before Phase 2: `ANTHROPIC_API_KEY` Edge Function secret.

## Sandbox notes (cloud sessions only)
- The cloud container re-terminates TLS through a proxy. For `supabase functions serve` to fetch jsr/npm imports, a git-ignored `supabase/functions/.env` sets `DENO_TLS_CA_STORE=mozilla,system` and `SSL_CERT_FILE`/`DENO_CERT` to a copy of `/root/.ccr/ca-bundle.crt` in `supabase/functions/.certs/` (also git-ignored). Not needed on a normal machine.
- gte-small can't download in the sandbox (edge runtime's downloader ignores the proxy CA). `scripts/sandbox/seed-gte-cache.sh` copies the model into the runtime cache; run it right after `functions serve` starts and before any embed call, and again after every `db reset` (which recreates the container; restart serve too).
- Docker isn't running at session start: `sudo dockerd &` first, then `npx supabase start -x studio,imgproxy,vector,logflare,supavisor,postgres-meta,mailpit`.
