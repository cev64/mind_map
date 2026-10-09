# Progress

## Current phase
**Phase 0 — Setup** (code done; waiting on Charlie for credentials and the first `main` deploy)

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
- **Repo is `cev64/mind_map` (underscore), not `mind-map`.** Pages URL is therefore `https://cev64.github.io/mind_map/`. Vite `base` defaults to `/mind_map/`; CI sets it from the repo name, so a rename to `mind-map` needs no code change.
- **Auth site URL:** the Budget project's Site URL is shared with the budget app, so we do **not** change it. We only add our URLs to the redirect allow-list and pass `emailRedirectTo` from the app.
- Project URL and publishable key were read from the Supabase project (both public); `.env.local` exists locally and is git-ignored.
- PWA (`vite-plugin-pwa`) deferred to Phase 3, when there's a real app shell and icons.

## Known issues
- `mind` is not yet in `supabase/config.toml` `[api] schemas`: PostgREST refuses to start while the schema doesn't exist. Add it in Phase 1 together with the migration that creates it.

## Next steps
1. Charlie: provide Supabase CLI access, set `ANTHROPIC_API_KEY`, add the two GitHub repository variables, set Pages source to GitHub Actions, merge to `main`.
2. Lead: `supabase link --project-ref sygxozspiszqfawkmpzx`, confirm the Pages deploy is live, then start Phase 1 (data layer).

## Sandbox notes (cloud sessions only)
- The cloud container re-terminates TLS through a proxy. For `supabase functions serve` to fetch jsr/npm imports, a git-ignored `supabase/functions/.env` sets `DENO_TLS_CA_STORE=mozilla,system` and `SSL_CERT_FILE`/`DENO_CERT` to a copy of `/root/.ccr/ca-bundle.crt` in `supabase/functions/.certs/` (also git-ignored). Not needed on a normal machine.
- Docker isn't running at session start: `sudo dockerd &` first, then `npx supabase start -x studio,imgproxy,vector,logflare,supavisor,postgres-meta,mailpit`.

## Open question for Charlie
- `CLAUDE.md` and the plan say `cev64/mind-map`; the real repo is `cev64/mind_map`. Either rename the repo to `mind-map` (no code change needed; update `vite.config.ts` default) or update `CLAUDE.md` to `mind_map`.
