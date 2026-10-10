# Handoff: Mind Map build, start of Phase 2b

You are taking over as **lead** on Charlie's Mind Map build. Phases 0, 1 and 2 are done, deployed and verified. Your job is **Phase 2b: the link suggester**.

## Read first, in this order
1. `CLAUDE.md`: project rules. They are binding.
2. `PROGRESS.md`: current state, every decision made so far, known issues, and sandbox notes.
3. `MIND_MAP_PLAN.md`: §3 (data model, `link_checks`, `link_candidates`), §5 and §5b (embed → link chain, link suggester spec), §8 (Phase 2b ✅ checks), §9 (guardrails).
4. The existing code you will build on:
   - `supabase/functions/embed/index.ts` has a `PHASE 2b HOOK` comment where `link` gets chained.
   - `supabase/functions/_shared/` holds `embed.ts`, `mind.ts`, `supabaseAdmin.ts` and `supabaseUser.ts`.
   - `supabase/functions/chat/` shows the house style for calling Claude: SDK pin, beta streaming, strict tools.
   - `supabase/migrations/20261009220918_mind_schema.sql` already contains `mind.link_checks` and `mind.link_candidates()`.

## Where things stand
- **Live site:** https://cev64.github.io/mind_map/. The repo name uses an underscore; this is intentional. Pushing to `main` deploys.
- **Work branch:** `claude/new-session-9rd51h`. Commit with messages like `phase 2b: link suggester`. Push to the branch. `main` gets updated only when a frontend deploy is wanted.
- **Supabase:** project **Budget**, ref `sygxozspiszqfawkmpzx`, shared with Charlie's `public` budget app and the `betting` and `claudehub` schemas. We own only `mind`.
  - Remote changes go through the **Supabase connector** (Charlie's decision), not the CLI: `apply_migration`, `execute_sql`, `deploy_edge_function`, `get_edge_function`, `get_advisors`.
  - Show Charlie the SQL summary and get his OK before applying any migration.
- **Deployed functions:**
  - `embed` (verify_jwt false, uses a DB-held webhook secret).
  - `chat` (verify_jwt true, acts as the caller's JWT).
  - `hello` exists only locally and is never deployed.
- **Secrets:** `ANTHROPIC_API_KEY` is already set as an Edge Function secret by Charlie. Never ask for keys in chat. Edge Functions get `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` automatically.

## Phase 2b task (plan §5b)
1. **Migration**: only if needed. `link_checks` and `link_candidates` already exist.
   - Plan §5b step 6 wants a debounce: if the same node is edited again within 30 seconds, only the last run proceeds. One way is a `last_link_request_at` column, or reuse `content_updated_at`. Decide, and record the decision in `PROGRESS.md`.
   - Tune `link_candidates`' default `min_similarity`. 0.55 filters nothing with gte-small. ~0.80 is the evidence-based starting point; see the calibration numbers in `supabase/functions/chat/config.ts`.
   - Every new function in `mind` must explicitly `revoke execute ... from public, anon`.
   - Every remote migration must end with `notify pgrst, 'reload schema';`.
2. **`link` Edge Function** (service role is allowed here per plan §9):
   - Call `link_candidates(node_id, 10, <threshold>)`.
   - Make **one** Haiku call with a strict `submit_links` tool.
   - Insert pending edges for verdicts with confidence ≥ 0.6, `created_by='claude'`, `meta.source='link_suggester'`, `weight=confidence`. Use `active` only if `auto_apply` is on and confidence ≥ `link_auto_accept_confidence`.
   - Upsert every judged pair into `link_checks` with node_a = the smaller uuid.
   - Skip `rejected`/`archived` nodes. Respect `settings.link_suggester`.
   - Authenticate the same way `embed` does (the `x-mind-webhook-secret` header, checked against `mind.internal_config`). Don't invent a new secret path.
3. **Chain it from `embed`**: after a successful embedding write, fire-and-forget POST to `{functions_url}/link`. Mind `EdgeRuntime.waitUntil`, so the request isn't killed when `embed` returns.
4. **✅ checks from plan §8, on the remote project:**
   - A node inserted by SQL that obviously supports an existing one gets a pending edge with a sensible rationale within ~10 s.
   - An unrelated node on a similar topic gets no edge, but the pair is recorded in `link_checks`.
   - Editing a node's body re-checks its pairs; re-saving without changes does not.
5. Run the `reviewer` subagent, fix what it flags, update `PROGRESS.md`, commit, then **stop** and give Charlie step-by-step manual test instructions.

## Claude API facts, already verified against the current docs. Don't rely on memory.
- **Model IDs:**
  - `claude-haiku-5-5` for link and reflect.
  - `claude-sonnet-5-5` for chat (default).
  - `claude-opus-5-5`.
  - Use the exact strings with no date suffix.
- **Haiku 5.5:**
  - Adaptive thinking only; `budget_tokens` returns 400.
  - Default effort is `medium`. Use `output_config: {effort: "low"}` for link judging.
  - Non-default temperature returns 400.
  - **No server-side fallback**: don't send `fallbacks`. Handle `stop_reason: "refusal"` yourself.
- **Forced tool use** (`tool_choice` any/tool) returns 400 on these models. Use `auto`, plus an instruction to call `submit_links`, plus `strict: true`, then check that the call happened. Structured outputs (`output_config.format`) are an alternative for a single JSON verdict.
- **Strict tool schemas:** a nullable enum or object must be written as `anyOf: [<schema>, {type: "null"}]`. An enum under `type: ["string","null"]` is rejected. At most 16 union-typed params are allowed across all tools in one request.
- **SDK:** `npm:@anthropic-ai/sdk@0.132.1`, already pinned in `chat/deno.json`. Deno's min-dependency-age check blocks very new versions.
- The `claude-api` skill holds the full reference. Load it before writing API code.

## Testing
- **Local** (cloud sandbox): run `scripts/sandbox/setup.sh` once per container. It does npm install, starts Docker and the local Supabase stack, writes the edge-runtime TLS env, starts `functions serve`, pre-seeds gte-small, and runs db reset with seed and embeddings.
  - After any `db reset`, or any file change under `supabase/functions`, re-run `scripts/sandbox/reset-local.sh` or at least `scripts/sandbox/seed-gte-cache.sh`. See the sandbox notes in `PROGRESS.md`.
  - Local login: `test@example.com` / `password`.
  - **There is no Anthropic key locally**, so Claude calls can only be tested on remote.
- **Remote:** a temporary user `mindmap-test@example.com` exists. Charlie approved it for testing; it holds 4 sample nodes from Phase 2.
  - Its password is not stored anywhere. Set a fresh one via `execute_sql`: `update auth.users set encrypted_password = extensions.crypt('<random>', extensions.gen_salt('bf')) where email = 'mindmap-test@example.com';`
  - Then get a JWT: `POST https://sygxozspiszqfawkmpzx.supabase.co/auth/v1/token?grant_type=password` with header `apikey: sb_publishable_kGqfG5NhqqT1pzWU429lUw_myf6Y4qr`.
  - For 2b, insert test nodes by SQL as that user (`user_id` = its id) and watch `net._http_response`, `mind.edges` and `mind.link_checks`.
  - **When Phase 2b is verified, delete this user** (`delete from auth.users where email = 'mindmap-test@example.com'`; the cascade removes its rows). The connector asks Charlie to confirm DELETEs, and the request times out after 60 s if he isn't watching.
- **Deploying through the connector** means sending every file of the function inline. Include `_shared/*` files the function imports. Afterwards, `get_edge_function` and diff against the repo; the result is large, so save it and diff with python.

## Open items to raise with Charlie (from the Phase 2 review)
1. **Cost exposure, highest priority before Phase 3 goes live.**
   - Any account that can sign in to the shared Budget project can call `chat` and spend the Anthropic key.
   - Recommend an allowlist: check the caller's user id against an `ALLOWED_USER_IDS` Edge Function secret in `chat` (and `link`, if it's ever user-callable). Alternatively, confirm with Charlie that email signups are disabled for the project.
   - Ask him which he prefers.
2. `deno check` reports 2 errors: the `Supabase` global namespace in `_shared/embed.ts`. The runtime is fine; it's a types-import issue. Fix it if cheap.
3. A failed persist mid-loop, or two concurrent requests on one conversation, could leave an unmatched `tool_use` in history and break that conversation. Consider repairing unmatched `tool_use` blocks in `loadHistory`.
4. Remote node `055f2fde-…` (Phase 1 test, `meta.test='phase1'`) is in Charlie's own account, marked `rejected`. Delete it when Charlie can confirm.
5. Token usage is logged in a new `messages.meta` column rather than "content metadata" as plan §9 says. Tell Charlie at the checkpoint.

## After 2b
Phase 3 is the map and chat UI (plan §7–8). `STYLE.md` governs all visuals; the design tokens are in `src/styles/tokens.css`. The `chat` SSE contract and the node-chip format are documented in `PROGRESS.md` under Decisions. Magic-link login: ask Charlie which email to use (don't commit it; the repo is public). Add `https://cev64.github.io/mind_map/` and `http://localhost:5173/mind_map/` to the Supabase Auth redirect allow-list (dashboard: Authentication → URL Configuration). **Never change the Site URL.**
