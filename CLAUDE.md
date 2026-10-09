# Mind Map — Claude Code project rules

This repo builds Charlie's "map of my mind" app. The full spec is in `MIND_MAP_PLAN.md`; these are the rules that apply in every session.

## Start of every session
1. If `PROGRESS.md` exists, read it first and resume from the phase and next step it lists.
2. Otherwise read `MIND_MAP_PLAN.md` top to bottom and start Phase 0.
3. Read `STYLE.md` before any UI work. It overrides every visual detail in the plan.

## How to work
- Build phase by phase (plan section 8). At the end of each phase: run its ✅ checks, update `PROGRESS.md`, commit (`phase N: <name>`), then **stop** and tell Charlie what to test by hand, step by step. Wait for "continue."
- Ask before deviating from the plan. Explain the change in 2–3 sentences.
- Never guess credentials. Ask for exactly what you need and where to find it.

## Agent team
- You are the lead; run on Opus. Specialist subagents live in `.claude/agents/` (created in Phase 0; roster and rules in plan section 0, "Agent team"): `researcher` (haiku), `db-engineer`, `functions-engineer`, `frontend-engineer` (sonnet), `reviewer` (opus).
- Delegate self-contained tasks; do small or tightly coupled changes yourself. Parallelize only across different directories, or use worktree isolation.
- Only the lead commits, updates `PROGRESS.md`, touches the remote Supabase project, sets secrets, or talks to Charlie. Verify every subagent's work before integrating.
- Run `reviewer` before every checkpoint and fix what it flags until it passes.

## Hard rules
- **Supabase:** project **Budget**, ref `sygxozspiszqfawkmpzx`. Everything in the **`mind` schema** only. Never touch `public` or the budget tables. All DB changes are migration files in `supabase/migrations/`; show Charlie the SQL summary before applying to remote.
- **Claude API:** Messages API with native tool use, called **only** from Supabase Edge Functions. Key is the Edge Function secret `ANTHROPIC_API_KEY`. **No MCP anywhere.** Check docs.claude.com for current model IDs and request formats before writing API code.
- **Hosting:** static Vite build on **GitHub Pages** (`cev64/mind-map` → `https://cev64.github.io/mind-map/`) via GitHub Actions. `base: '/mind-map/'`, hash routing, PWA scoped to `/mind-map/`.
- **Public repo:** never commit keys, tokens, `.env.local`, or real personal content. Seed data is generic sample content.
- **Design:** tokens from `STYLE.md` in one place (Tailwind theme / CSS variables); no hard-coded colors or font sizes in components. Test at ~380px (Fold folded), ~900px (unfolded), and desktop.
