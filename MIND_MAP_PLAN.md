# Mind Map — Build Plan for Claude Code

## How to use this file (for Charlie)

1. Create a new GitHub repo named `mind-map` under `cev64`. Make it **public** (GitHub Pages on a free account only serves public repos; nothing secret ever goes in the repo, so that's safe).
2. Put three files in the repo root:
   - this `MIND_MAP_PLAN.md`
   - `CLAUDE.md` (Claude Code reads it automatically at the start of every session)
   - your styling file, renamed to `STYLE.md`
3. In the repo on GitHub: **Settings → Pages → Source: GitHub Actions.**
4. Open Claude Code in that repo and paste:

   > Read MIND_MAP_PLAN.md top to bottom, then follow section 0 exactly. Start with Phase 0.

5. Each time it stops at a checkpoint, test what it lists, then reply "continue" (or tell it what's wrong). If you start a fresh session later, just say "continue the build" and it will pick up from `PROGRESS.md`.

The live app will be at **https://cev64.github.io/mind-map/**.

---

## 0. Instructions for Claude Code

You are building this app for Charlie. Read this whole document before writing any code. These rules apply for the entire build.

### Ground rules
- **Work phase by phase** (section 8). Finish one phase, run its checks yourself, then **stop** and report: what you built, how you tested it, what Charlie should test by hand (exact steps), and anything you were unsure about. Don't start the next phase until he says "continue."
- **Commit at the end of each phase** with a message like `phase 2: chat brain`. Use small commits within a phase when it helps.
- **Keep a `PROGRESS.md`** in the repo root: current phase, what's done, decisions made, known issues, next steps. Update it before each stop so a fresh session can pick up where you left off. If you're starting and `PROGRESS.md` exists, read it first and resume from there.
- **Ask before deviating.** If something in this plan is wrong, outdated, or a clearly better option exists, stop and explain the change in two or three sentences before making it. Small implementation details are your call.
- **Never guess credentials.** When you need something only Charlie has, list exactly what you need and where to find it, then wait.

### Agent team (subagents)
You are the **lead**. Run the main session on Opus (`/model opus`). You plan each phase, split it into tasks, delegate to subagents, integrate their work, and own everything that touches Charlie or the outside world. Subagents do focused work and report back to you.

In Phase 0, create these subagent definitions in `.claude/agents/` (one `.md` file each, with `name`, `description`, `tools`, `model` frontmatter and a short system prompt that points at the relevant plan sections and `CLAUDE.md`):

| Agent | Model | Tools | Job |
|---|---|---|---|
| `researcher` | haiku | Read, Grep, Glob, WebFetch, WebSearch | Looks up current docs (Claude API tool use / streaming / prompt caching / model IDs, Supabase Edge Functions & pgvector, `react-force-graph`, `vite-plugin-pwa`, GitHub Pages) and returns short findings with links. Never edits files. |
| `db-engineer` | sonnet | Read, Write, Edit, Grep, Glob, Bash | Migrations, RLS, triggers, indexes, RPCs in `supabase/migrations/`. Tests against the **local** Supabase stack only. |
| `functions-engineer` | sonnet | Read, Write, Edit, Grep, Glob, Bash | Edge Functions in `supabase/functions/` (`chat`, `embed`, `link`, `reflect`, import). Tests locally with `supabase functions serve`. |
| `frontend-engineer` | sonnet | Read, Write, Edit, Grep, Glob, Bash | Everything in `src/`. Reads `STYLE.md` first and builds only from design tokens. |
| `reviewer` | opus | Read, Grep, Glob, Bash | Fresh-eyes check at the end of every phase. Reviews the diff against the phase's ✅ checks, this plan, and `CLAUDE.md`: correctness, RLS on every table, no secrets or personal data in the repo, `mind`-schema-only, no MCP, design tokens used. Runs the build/type-check/tests. Reports a pass/fail list; never fixes anything itself. |

**How to delegate**
- Delegate when a task is self-contained and can be described in a few sentences with clear inputs, outputs, and a way to verify it. Do small or tightly coupled changes yourself; spawning an agent for a two-line fix wastes time.
- Run agents **in parallel** only when they work in different directories (e.g. `db-engineer` in `supabase/migrations/` while `frontend-engineer` builds UI shells in `src/`, or several `frontend-engineer` agents on separate components using `isolation: "worktree"`). Never let two agents edit the same files at once.
- Use `researcher` before writing any code that depends on an external API's current format, instead of relying on memory.
- Give each agent everything it needs in its prompt: the task, relevant plan section numbers, file paths, the contract it must meet (function signatures, table names, props), and how to verify. Ask it to return a short summary of what it changed and how it tested it.
- **Only the lead** commits, updates `PROGRESS.md`, applies migrations or deploys functions to the remote project, sets secrets, and talks to Charlie. Subagents work locally and report back.
- Check every subagent's result yourself before integrating (read the diff, run the check). Don't trust a summary alone.
- Before stopping at each checkpoint, run `reviewer`. Fix everything it flags (or delegate the fix), then re-run it until it passes. Include its verdict in your checkpoint report.

### Supabase rules
- Use the existing project **Budget**, ref `sygxozspiszqfawkmpzx`. Do **not** create a new project.
- Everything goes in the **`mind` schema**. Never create, alter, or drop anything in `public` or any other schema, and never read from the budget tables.
- All database changes are **migration files** in `supabase/migrations/`, applied through the Supabase CLI. No ad-hoc changes in the dashboard.
- Before applying any migration to the remote project, show Charlie the SQL summary and confirm.
- Enable `vector` in the `extensions` schema (`create extension if not exists vector with schema extensions;`).

### Anthropic API rules
- Call the Anthropic Messages API **only from Edge Functions**. The key lives in the Edge Function secret `ANTHROPIC_API_KEY`; it must never appear in frontend code, the repo, or logs.
- Use native tool use from the Messages API. **Do not build or use MCP** anywhere in this project.
- Before writing the `chat` function, check docs.claude.com for the current model IDs, tool-use request/response format, streaming, and prompt caching, and use what the docs say if it differs from this plan.

### Hosting rules (GitHub Pages)
- The frontend is a static Vite build deployed to **GitHub Pages** from repo `cev64/mind-map` via a GitHub Actions workflow (`.github/workflows/deploy.yml`) on every push to `main`. Live URL: `https://cev64.github.io/mind-map/`.
- Set Vite `base: '/mind-map/'` so assets resolve under the repo path.
- Use **hash routing** (`createHashRouter` or equivalent) so deep links and refreshes work on Pages without server rewrites.
- PWA: use `vite-plugin-pwa` with `scope` and `start_url` set to `/mind-map/`.
- Build-time config comes from GitHub Actions **repository variables** `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (both are safe to be public). No other secrets exist in the frontend or the workflow.
- The repo is **public**: never commit `.env.local`, keys, tokens, or personal data. Add a `.gitignore` before the first commit. Seed data must be generic sample content, not Charlie's real thoughts.
- Supabase Auth: the site URL and redirect allow-list must include `https://cev64.github.io/mind-map/` (and `http://localhost:5173/mind-map/` for dev) so magic links land back in the app. Tell Charlie exactly where to set this if you can't do it from the CLI.
- Edge Functions and migrations are deployed with the Supabase CLI from Claude Code (not from GitHub Actions), after Charlie confirms.

### Design rules
- **`STYLE.md` in the repo root is the source of truth for all visual design**: colors, fonts, spacing, radii, shadows, component look, light/dark behavior. Read it before Phase 3 and follow it over any visual suggestion in this plan.
- Translate it into design tokens first (Tailwind theme config and/or CSS variables in one place), then build components only from those tokens. No hard-coded colors or font sizes in components.
- The node-kind colors and edge-kind styles in section 7 describe *what needs to be distinguishable*, not the exact colors. Pick them from the `STYLE.md` palette. If the palette doesn't have enough distinct colors for 10 node kinds, propose a mapping and ask.
- Must work at phone width (Charlie uses a Galaxy Z Fold, so test both a narrow folded width ~380px and an unfolded near-square ~900px) and on desktop.

### What Charlie needs to provide (ask for these in Phase 0, all at once)
- Supabase access token (or confirm `supabase login` is done) so the CLI can link project `sygxozspiszqfawkmpzx`.
- The project's URL and publishable key for `.env.local`.
- An Anthropic API key to set as the Edge Function secret.
- The email to use for the magic-link login.
- Confirmation that the GitHub repo `cev64/mind-map` exists, Pages source is set to GitHub Actions, and the two repository variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) are added under Settings → Secrets and variables → Actions → Variables. Give him the exact values to paste.

### Definition of done for each phase
- Its ✅ checks in section 8 pass, and you've shown how you verified them.
- The `reviewer` agent has passed the phase.
- No TypeScript errors, the app builds, and Edge Functions deploy.
- `PROGRESS.md` is updated and the work is committed.

---

## 1. What we're building

A personal "map of my mind": a live, visual graph of my ideas, beliefs, world views, goals and plans, plus a chat partner (Claude, via the Anthropic Messages API) that:

1. **Captures** — turns what I say into nodes and connections on the map.
2. **Recalls** — before answering, pulls the relevant parts of my map into context so it talks to me like it knows how I think.
3. **Connects** — branches ideas off each other, links new thoughts to old ones, notices when two beliefs contradict or a plan has nothing supporting it. Connections are found in three layers: live during chat, within seconds of any node being saved (the link suggester), and nightly (reflection).
4. **Reflects** — on a schedule, re-reads the whole map and maintains a short "self model" (my world view, active plans, open tensions, questions worth asking me).

The "mind reading" is not magic: **the database is the memory.** The Claude API is stateless and does not learn between calls. Every bit of "knowing me" comes from (a) what's been captured, (b) retrieving the right slice of it each turn, and (c) the reflection pass that compresses it into a self model.

**No MCP.** Claude uses tools through the Messages API's native tool use: we define tools in the request, Claude asks to call them, and our Edge Function executes them against Postgres and sends results back. Same mechanics as MCP, without a separate server or protocol.

## 2. Architecture

```
 Web app (Vite + React + TS)                Supabase (existing "Budget" project, new `mind` schema)
 ┌──────────────────────────┐               ┌───────────────────────────────────────────────┐
 │ Map view (force graph)   │◄── Realtime ──│ Postgres: mind.nodes, mind.edges, ...         │
 │ Chat panel               │               │   pgvector (384-d), RPCs for search/traverse  │
 │ Node inspector / Inbox   │── fetch ─────►│ Edge Fn `chat`   → Anthropic Messages API     │
 └──────────────────────────┘               │ Edge Fn `embed`  → built-in gte-small model   │
                                            │ Edge Fn `link`   ← after embed (Haiku pairs)  │
                                            │ Edge Fn `reflect`← pg_cron nightly            │
                                            └───────────────────────────────────────────────┘
```

- **Supabase project:** reuse the existing **Budget** project (ref `sygxozspiszqfawkmpzx`) so there's no extra project cost. Put everything in a separate `mind` schema so it never touches the budget tables. (pg_cron is already enabled there; pgvector is available but not yet enabled.)
- **Embeddings:** Supabase Edge Runtime's built-in `gte-small` model (`new Supabase.ai.Session('gte-small')`, 384 dimensions, `mean_pool: true, normalize: true`). Free, no external API.
- **LLM:** Anthropic Messages API, called only from Edge Functions. API key stored as an Edge Function secret (`ANTHROPIC_API_KEY`), never in the browser.
  - Chat: `claude-sonnet-5-5` (option to switch to `claude-opus-5-5` for deep sessions).
  - Background work (embedding-adjacent extraction, reflection, dedupe checks): `claude-haiku-5-5`.
  - Verify current model IDs and the tool-use/prompt-caching request format against docs.claude.com before coding.
  - Use prompt caching on the system prompt + self model block.
- **Frontend:** Vite + React + TypeScript + Tailwind, `@supabase/supabase-js`, `react-force-graph` (2D by default, 3D toggle). Hosted free on **GitHub Pages** (`https://cev64.github.io/mind-map/`), deployed by GitHub Actions. Build as a PWA so it installs on my phone.
- **Auth:** single user, Supabase Auth magic link. RLS on every table (`user_id = auth.uid()`), because the API is public-facing.

## 3. Data model

### Node kinds (what a thought *is*)
`idea`, `belief` (a world-view claim I hold), `value` (what I care about), `goal`, `plan`, `question` (open question I'm chewing on), `project`, `person`, `theme` (a cluster label), `insight` (something Claude or I concluded).

### Edge kinds (how thoughts relate)
| Edge | Meaning | Example |
|---|---|---|
| `branches_from` | B grew out of A | "iOS mind-map app" branches from "build a platform, not a utility" |
| `supports` | A is a reason for B | belief → plan |
| `contradicts` | A and B are in tension | two beliefs that pull opposite ways |
| `part_of` | A belongs to theme/project B | idea → theme |
| `depends_on` | A can't happen without B | plan → plan |
| `serves` | A advances goal B | plan → goal |
| `inspired_by` | A came from B (person, source, idea) | |
| `evolved_into` | A was replaced by a newer version B | old belief → updated belief |
| `relates_to` | weak catch-all; use sparingly | |

### Tables (schema `mind`)

```sql
create extension if not exists vector with schema extensions;
create schema if not exists mind;

create type mind.node_kind as enum ('idea','belief','value','goal','plan','question','project','person','theme','insight');
create type mind.edge_kind as enum ('branches_from','supports','contradicts','part_of','depends_on','serves','inspired_by','evolved_into','relates_to');
create type mind.item_status as enum ('pending','active','archived','rejected');

create table mind.nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users,
  kind mind.node_kind not null,
  title text not null,                -- short, <= 80 chars
  body text,                          -- the fuller thought, in my words where possible
  status mind.item_status not null default 'pending',
  conviction real check (conviction between 0 and 1),  -- how strongly I hold it (beliefs/values)
  importance real default 0.5 check (importance between 0 and 1),
  created_by text not null default 'claude' check (created_by in ('user','claude')),
  source_message_id uuid,             -- the chat message it came from
  embedding extensions.vector(384),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_touched_at timestamptz not null default now()  -- bumped when discussed/retrieved
);

create table mind.edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users,
  source_id uuid not null references mind.nodes on delete cascade,
  target_id uuid not null references mind.nodes on delete cascade,
  kind mind.edge_kind not null,
  weight real default 0.5,
  rationale text,                     -- why Claude/I linked these
  status mind.item_status not null default 'pending',
  created_by text not null default 'claude',
  created_at timestamptz not null default now(),
  unique (source_id, target_id, kind),
  check (source_id <> target_id)
);

create table mind.node_history (      -- beliefs change; keep the trail
  id bigint generated always as identity primary key,
  node_id uuid not null references mind.nodes on delete cascade,
  snapshot jsonb not null,
  changed_by text not null,
  reason text,
  created_at timestamptz not null default now()
);

create table mind.proposals (         -- changes that aren't simple inserts: merges, edits, archive
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users,
  op text not null check (op in ('update_node','merge_nodes','archive_node','retype_edge')),
  payload jsonb not null,
  rationale text,
  status mind.item_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table mind.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users,
  title text,
  created_at timestamptz not null default now()
);

create table mind.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references mind.conversations on delete cascade,
  role text not null check (role in ('user','assistant')),
  content jsonb not null,             -- full Anthropic content blocks incl. tool_use/tool_result
  created_at timestamptz not null default now()
);

create table mind.self_model (        -- output of the reflection pass; newest row is current
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users,
  content text not null,              -- markdown, <= ~1,500 words
  open_questions jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table mind.link_checks (       -- pairs the link suggester already judged; prevents re-paying / re-suggesting
  node_a uuid not null references mind.nodes on delete cascade,   -- always the smaller uuid
  node_b uuid not null references mind.nodes on delete cascade,   -- always the larger uuid
  result text not null,               -- edge kind chosen, or 'none'
  confidence real,
  checked_at timestamptz not null default now(),
  primary key (node_a, node_b),
  check (node_a < node_b)
);

create table mind.settings (
  user_id uuid primary key references auth.users,
  auto_apply boolean not null default false,   -- false = Claude's captures land as 'pending'
  link_suggester boolean not null default true,
  link_auto_accept_confidence real not null default 0.9,  -- only used when auto_apply = true
  chat_model text not null default 'claude-sonnet-5-5'
);
```

Plus: RLS on all tables; `updated_at` trigger; a trigger that writes `node_history` on update of title/body/conviction/kind; HNSW index on `nodes.embedding` (`vector_ip_ops`); indexes on `edges(source_id)`, `edges(target_id)`, `nodes(user_id, status, kind)`.

**Expose the schema:** add `mind` to the project's exposed API schemas, and add `mind.nodes`, `mind.edges`, `mind.proposals` to the `supabase_realtime` publication so the map updates live.

### RPC functions
- `mind.match_nodes(query_embedding vector(384), match_threshold float, match_count int, kinds mind.node_kind[] default null)` — semantic search, filter pushed inside the function, excludes `rejected`/`archived`.
- `mind.get_neighborhood(root_ids uuid[], depth int default 2)` — recursive CTE over edges in both directions; returns nodes + edges.
- `mind.link_candidates(node_id uuid, k int default 10, min_similarity float default 0.55)` — the k most similar active/pending nodes that are (a) not the node itself, (b) not already connected to it by any edge in either direction, and (c) not in `link_checks` for that pair, unless either node's `updated_at` is newer than `checked_at`.
- `mind.graph_snapshot()` — all active + pending nodes/edges (without embeddings) for the map.
- `mind.find_tensions()` — returns `contradicts` edges, plans with no `supports`/`serves` edges, goals with no plans, orphan nodes.

## 4. The brain: `chat` Edge Function

Per user message:

1. **Auth** the request (Supabase JWT), load settings.
2. **Build context** (this is the "reading my mind" step):
   - Latest `self_model` (cached prompt block).
   - Embed the message → `match_nodes` top ~12 → `get_neighborhood(depth 1)` around them → compact text rendering (`[id] kind: title — body` and `A --supports--> B`).
   - Last ~20 messages of the conversation.
3. **Call Claude** with the system prompt (below), context, and tools. Loop: execute any `tool_use` blocks, append `tool_result`, call again, until `stop_reason = end_turn`. Cap at ~8 iterations.
4. **Stream** the final text to the client; persist all messages (with tool blocks) to `mind.messages`.
5. Bump `last_touched_at` on nodes that were retrieved or discussed.

### Tools exposed to Claude (JSON Schema in the request)

| Tool | Input | Behavior |
|---|---|---|
| `search_mind` | `query`, optional `kinds[]`, `limit` | Embeds query, calls `match_nodes`, returns compact list. |
| `open_node` | `node_id`, `depth` (1–2) | Returns node, its history summary, and neighborhood. |
| `capture` | `nodes[]` {`temp_id`, `kind`, `title`, `body`, `conviction?`, `importance?`}, `edges[]` {`from`, `to`, `kind`, `rationale`} where `from`/`to` are existing ids or temp_ids | **Dedupe first:** for each new node, run `match_nodes` at ~0.88; if a near-duplicate exists, don't insert — return it in the result as `possible_duplicate` so Claude links/updates instead. Insert remaining nodes/edges with `status = auto_apply ? 'active' : 'pending'`, `created_by='claude'`, `source_message_id`. Return real ids. |
| `propose_change` | `op`, `payload`, `rationale` | Writes to `mind.proposals` (edits, merges, archives always need my approval). |
| `branch` | `parent_id`, `children[]` {`kind`,`title`,`body`} | Convenience: creates children + `branches_from` edges. |

Embeddings for new/edited nodes are produced by the `embed` function (below), so `capture` should embed inline for dedupe and store the vector directly.

### System prompt (starting point — tune later)

```
You are the thinking partner inside Charlie's mind map. The map is a graph of his ideas,
beliefs, values, goals, plans, questions and projects. Your jobs, in order:

1. Talk with him like someone who knows how he thinks. Use the self model and retrieved
   nodes; reference specific nodes naturally. Never invent things he hasn't said.
2. Capture. When he expresses a new idea, belief, goal, plan or question, call `capture`.
   Keep titles short and in his words. Capture his thoughts, not your advice — your
   suggestions are only captured if he adopts them (then created_by stays 'claude' but
   the node reflects his decision).
3. Connect. Always look for how a new thought relates to existing ones (search first).
   Prefer specific edges (supports, contradicts, serves, branches_from) over relates_to.
   Give a one-line rationale for every edge.
4. Notice. If something contradicts an existing belief, or a plan has no reason or goal
   behind it, say so briefly and ask about it. Don't lecture.
5. Don't over-capture. Small talk, questions to you, and one-off facts are not nodes.
   One message usually yields 0–3 nodes.

Edits to existing nodes, merges and archives go through `propose_change`, never silently.
```

## 5. `embed` Edge Function
Database webhook on `mind.nodes` insert/update (when `title` or `body` changes): embed `kind + ': ' + title + '\n' + body` with gte-small and write `embedding`. Idempotent; skip if the text hasn't changed. After a successful write, invoke `link` for that node (fire-and-forget) if `settings.link_suggester` is on.

## 5b. `link` Edge Function — the link suggester
Finds connections within seconds of any node being saved, including ones Claude didn't think to search for mid-conversation and ones from nodes I create by hand.

1. Call `mind.link_candidates(node_id, 10, 0.55)`. If none, stop.
2. Send **one** Haiku request containing the new node and all candidates (id, kind, title, body). Ask for a JSON verdict per pair — use tool use with a strict schema (e.g. a `submit_links` tool) so output is structured:
   - `candidate_id`
   - `relation`: one of `supports`, `contradicts`, `branches_from`, `serves`, `depends_on`, `part_of`, `inspired_by`, or `none` (no `relates_to` — if it can't name a specific relation, it's `none`)
   - `direction`: `new_to_candidate` or `candidate_to_new`
   - `confidence` 0–1
   - `rationale`: one line, specific ("both are about cutting recurring hosting cost")
3. Instructions to Haiku: being similar in topic is not enough; only propose a link if knowing one node changes how you'd read the other. Most pairs should be `none`.
4. For each verdict with `relation != 'none'` and `confidence >= 0.6`: insert an edge with `created_by='claude'`, `meta.source='link_suggester'`, `rationale`, `weight = confidence`. Status is `pending`, unless `auto_apply` is on **and** confidence ≥ `link_auto_accept_confidence`, then `active`.
5. Upsert every judged pair (including `none`) into `link_checks` so it's never re-evaluated unless one of the nodes changes.
6. Cost guards: max 10 candidates per node, one Haiku call per node, skip nodes with status `rejected`/`archived`, and debounce — if the same node is edited again within 30 seconds, only the last run proceeds.

Rejecting a suggested edge in the UI also records that pair in `link_checks` with `result='none'`, so it doesn't come back.

## 6. `reflect` Edge Function (the "mind reading" upgrade)
Scheduled nightly via pg_cron + `pg_net` (and runnable on demand from the UI).

1. Load: current self model, nodes/edges changed since last run, `find_tensions()`, top nodes by importance + degree.
2. Ask Claude (Haiku, or Sonnet weekly) to produce:
   - Updated **self model** (markdown): core values, world views, active goals → plans, recurring themes, how beliefs have shifted (from `node_history`).
   - **Open questions** (3–5) worth asking me next time — gaps, tensions, stale plans.
   - **Proposals**: missing links, likely duplicates to merge, `theme` nodes for emerging clusters, stale nodes to archive.
3. Write `self_model` row and `proposals` (all `pending`).
4. The next chat session opens with one of the open questions if I start with a greeting.

## 7. Frontend

All visual styling comes from `STYLE.md` (see section 0, Design rules). Colors named below are placeholders for "visibly different," not requirements.

Layout: map fills the screen, chat panel docked right (bottom sheet on mobile), node inspector as a drawer.

**Views**
- **Galaxy** — whole graph, force layout, nodes grouped by `theme`. Color = node kind; size = importance + degree; edge style = kind (`supports` green, `contradicts` red, `branches_from` dashed, `relates_to` faint). Pending items render as translucent "ghost" nodes/edges with an accept/reject affordance.
- **Focus** — click a node: it centers, shows 2 hops, everything else fades. "Branch" button adds a child; drag from one node to another to create an edge (pick kind).
- **Inbox** — pending nodes, edges, proposals; bulk accept/reject; edit before accepting. Group link-suggester edges under the node that triggered them, showing each rationale, so I can review "here's what this new idea connects to" in one glance.
- **Self** — current self model + open questions + "Run reflection now."
- **Search** — semantic search box (calls an edge fn or RPC) that flies the camera to results.

Live: subscribe to Realtime on `mind.nodes` / `mind.edges` so nodes pop onto the map while I'm talking. When Claude references a node in chat, render it as a chip that focuses the map on click.

2D by default; 3D toggle (`react-force-graph-3d`) for fun once it works.

## 8. Phases (stop after each for me to test)

**Phase 0 — Setup**
- Repo scaffold (Vite React TS + Tailwind, hash router, `base: '/mind-map/'`), `.gitignore`, `.env.example`, Supabase CLI linked to project `sygxozspiszqfawkmpzx`.
- GitHub Actions workflow that builds and deploys to GitHub Pages on push to `main`.
- Subagent definitions in `.claude/agents/` (section 0, Agent team).
- Secrets: `ANTHROPIC_API_KEY` set on Edge Functions.
- ✅ `supabase functions serve` runs locally; app loads locally **and** a placeholder page is live at `https://cev64.github.io/mind-map/` after a push.

**Phase 1 — Data layer**
- Migration for section 3 (schema, enums, tables, RLS, triggers, indexes, RPCs, realtime publication).
- `embed` function + webhook.
- Seed script with ~15 sample nodes/edges.
- ✅ Insert a node → embedding appears; `match_nodes` returns sensible results; `get_neighborhood` works; budget tables untouched.

**Phase 2 — Chat brain (no UI yet)**
- `chat` function with context building, tool loop, persistence.
- ✅ Via curl: tell it three related ideas across two messages → nodes + correct edges created as `pending`; restating an idea doesn't duplicate it; asking "what do I think about X?" uses retrieved nodes.

**Phase 2b — Link suggester**
- `link_checks` table, `link_candidates` RPC, `link` function chained from `embed`, settings toggles.
- ✅ Insert a node by SQL that obviously supports an existing one → a pending edge with a sensible rationale appears within ~10 seconds. Insert an unrelated node on a similar topic → no edge, but the pair is recorded in `link_checks`. Editing a node's body re-checks its pairs; re-saving without changes does not.

**Phase 3 — Map + chat UI**
- Galaxy + Focus views, chat panel, Realtime, node inspector (edit title/body/kind/conviction), manual branch and link.
- Magic-link sign-in.
- ✅ On the live GitHub Pages URL (not just localhost): I can sign in by magic link, talking in chat makes ghost nodes appear live, and I can accept them, branch, and link by dragging. Works folded and unfolded on the Fold.

**Phase 4 — Inbox & review**
- Inbox view for pending nodes/edges/proposals; `auto_apply` toggle in settings.
- ✅ Merge proposal correctly re-points edges and archives the loser with history.

**Phase 5 — Reflection**
- `reflect` function, pg_cron schedule, Self view, open questions surfaced in chat.
- ✅ After a run, self model reads like an accurate summary of me; tensions show up as proposals/questions.

**Phase 6 — Seeding my mind**
- "Import" screen: paste a long brain-dump (notes, a memory export from another assistant, journal text) → Haiku extracts nodes/edges in chunks → all land as `pending` for review.
- ✅ A 2,000-word dump produces a reviewable, deduped batch.

**Phase 7 — Later**
- **Quick capture** (all hit `chat` with a `capture_only` flag — save and link, no conversation):
  - Hold-to-talk voice button in the app (browser speech-to-text → text → `chat`).
  - PWA **Web Share Target** so on Android I can highlight text anywhere → Share → Mind Map.
  - Later: a capture app for my Even Realities G2 glasses posting to the same endpoint.
- PWA install polish + offline read cache. Native mobile app later on the same backend.
- Timeline scrubber (watch the map grow; see how a belief evolved).

## 9. Guardrails
- Anthropic key only in Edge Function secrets; browser uses the publishable key + user JWT.
- Every table has RLS; Edge Functions use the user's JWT for reads/writes, service role only in `embed`/`reflect`.
- Nothing Claude creates is permanent without being reviewable: pending by default, history on every edit, proposals for destructive changes.
- Keep `mind` fully separate from the budget schema; no cross-schema joins.
- The repo is public: no keys, tokens, `.env.local`, or real personal content in git, ever. All personal data lives only in Supabase behind RLS.
- Log token usage per call (in `messages.content` metadata) so I can watch API cost.
