# Progress

## Current phase
**Phase 1 — Data layer** (in progress). Phase 0 complete: placeholder live at https://cev64.github.io/mind_map/.

## Done
- Vite 8 + React 19 + TypeScript + Tailwind v4 scaffold. Hash routing (`createHashRouter`, react-router 8).
- Design tokens from `STYLE.md` in `src/styles/tokens.css` (light + dark), glass recipes and ambient backdrop in `src/index.css`. Inter + Barlow Condensed bundled locally via `@fontsource`.
- Placeholder home page (shows whether Supabase env is configured).
- `.gitignore` (ignores `.env*` except `.env.example`), `.env.example`.
- `supabase/` initialised (CLI as a dev dependency, run with `npx supabase`). Local config allows `localhost:5173/mind_map/` + the Pages URL as auth redirects.
- `hello` Edge Function (health check) for the Phase 0 serve check.
- `.github/workflows/deploy.yml`: lint, build, deploy to Pages on push to `main`.
- Subagents in `.claude/agents/`: researcher, db-engineer, functions-engineer, frontend-engineer, reviewer.

## Decisions
- **Repo is `cev64/mind_map` (underscore), confirmed by Charlie; CLAUDE.md and the plan updated.** Pages URL is therefore `https://cev64.github.io/mind_map/`. Vite `base` defaults to `/mind_map/`; CI sets it from the repo name, so a rename to `mind-map` needs no code change.
- **Auth site URL (confirmed by Charlie):** the Budget project's Site URL is shared with the budget app, so we do **not** change it. We only add our URLs to the redirect allow-list and pass `emailRedirectTo` from the app.
- Project URL and publishable key were read from the Supabase project (both public); `.env.local` exists locally and is git-ignored.
- **Remote Supabase changes go through the Supabase connector** (confirmed by Charlie), not the CLI: no access token or DB password needed. Migrations are still files in `supabase/migrations/`, tested on the local stack first, SQL shown to Charlie before applying.
- GitHub: `main` is the default branch; the `github-pages` environment allows deploys from `main`. The session's GitHub integration can't re-run or dispatch workflows, so a deploy is triggered by pushing to `main`.
- PWA (`vite-plugin-pwa`) deferred to Phase 3, when there's a real app shell and icons.

## Known issues
- None.

## Next steps
1. Phase 1: migration for plan section 3, `embed` function + webhook, seed script; test locally, then show Charlie the SQL and apply via the connector.
2. Still needed from Charlie before Phase 2: `ANTHROPIC_API_KEY` set as an Edge Function secret (dashboard → Edge Functions → Secrets), and the magic-link email (before Phase 3).

## Sandbox notes (cloud sessions only)
- The cloud container re-terminates TLS through a proxy. For `supabase functions serve` to fetch jsr/npm imports, a git-ignored `supabase/functions/.env` sets `DENO_TLS_CA_STORE=mozilla,system` and `SSL_CERT_FILE`/`DENO_CERT` to a copy of `/root/.ccr/ca-bundle.crt` in `supabase/functions/.certs/` (also git-ignored). Not needed on a normal machine.
- Docker isn't running at session start: `sudo dockerd &` first, then `npx supabase start -x studio,imgproxy,vector,logflare,supavisor,postgres-meta,mailpit`.
