-- Phase 2b: link suggester support (plan section 5b).
-- 1. mind.link_runs: one row per `link` run (debounce state + per-call model/usage log for cost watching).
-- 2. mind.claim_link_run(): atomic per-node debounce gate used by the `link` Edge Function.
--    mind.insert_link_edges(): pair-locked edge insert, so concurrent runs can't link one pair twice.
-- 3. mind.link_candidates(): default min_similarity 0.55 -> 0.78 (gte-small similarities are compressed high).

-- ---------------------------------------------------------------------------
-- 1. link_runs
-- ---------------------------------------------------------------------------
create table mind.link_runs (
  id bigint generated always as identity primary key,
  node_id uuid not null references mind.nodes on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  node_version timestamptz not null,   -- nodes.content_updated_at this run judged
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'done', 'no_candidates', 'skipped', 'error')),
  candidates int,
  edges_created int,
  model text,
  usage jsonb,
  error text
);

create index link_runs_node_started_idx on mind.link_runs (node_id, started_at desc);
create index link_runs_node_version_idx on mind.link_runs (node_id, node_version);
create index link_runs_user_started_idx on mind.link_runs (user_id, started_at desc);

alter table mind.link_runs enable row level security;

-- Owner can read their own runs (token usage); only the service role writes.
create policy link_runs_select on mind.link_runs for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on mind.link_runs from public, anon, authenticated;
grant select on mind.link_runs to authenticated;
grant all on mind.link_runs to service_role;

-- ---------------------------------------------------------------------------
-- 2. claim_link_run: debounce gate
-- ---------------------------------------------------------------------------
-- Called by `link` with the content version (nodes.content_updated_at) it was triggered for.
--   'superseded'  the node was edited again since; that edit's own run will handle it.
--   'done'        this version already has a run (running, or finished without error); nothing to do.
--                 A run still 'running' after 5 minutes is treated as dead (killed isolate).
--   'wait'        a run for this node started less than p_min_interval ago; retry after wait_seconds.
--   'claimed'     a link_runs row was inserted; proceed. run_id/started_at identify it.
--   'missing'     the node no longer exists.
-- Effect: the first save runs immediately; further saves within the window collapse into one trailing run
-- for the newest version, so at most one Haiku call per node per window.
create function mind.claim_link_run(
  p_node_id uuid,
  p_version timestamptz,
  p_min_interval interval default interval '30 seconds'
)
returns table (status text, wait_seconds float, run_id bigint, started_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid;
  v_current timestamptz;
  v_last timestamptz;
  v_run bigint;
  v_now timestamptz := clock_timestamp();
begin
  -- serialize claims per node (transaction-scoped, released on commit)
  perform pg_advisory_xact_lock(hashtextextended('mind.link:' || p_node_id::text, 0));

  select n.user_id, n.content_updated_at into v_user, v_current
  from mind.nodes n where n.id = p_node_id;
  if not found then
    return query select 'missing'::text, null::float, null::bigint, null::timestamptz;
    return;
  end if;
  if v_current is distinct from p_version then
    return query select 'superseded'::text, null::float, null::bigint, null::timestamptz;
    return;
  end if;
  if exists (
    select 1 from mind.link_runs r
    where r.node_id = p_node_id and r.node_version = p_version and r.status <> 'error'
      and not (r.status = 'running' and r.started_at < v_now - interval '5 minutes')  -- killed isolate
  ) then
    return query select 'done'::text, null::float, null::bigint, null::timestamptz;
    return;
  end if;

  select max(r.started_at) into v_last from mind.link_runs r where r.node_id = p_node_id;
  if v_last is not null and v_last > v_now - p_min_interval then
    return query select 'wait'::text,
      extract(epoch from (v_last + p_min_interval - v_now))::float, null::bigint, null::timestamptz;
    return;
  end if;

  insert into mind.link_runs (node_id, user_id, node_version, started_at)
  values (p_node_id, v_user, p_version, v_now)
  returning id into v_run;
  return query select 'claimed'::text, 0::float, v_run, v_now;
end;
$$;

revoke execute on function mind.claim_link_run(uuid, timestamptz, interval) from public, anon, authenticated;
grant execute on function mind.claim_link_run(uuid, timestamptz, interval) to service_role;

-- insert_link_edges: inserts the suggester's edges, skipping any pair that is already connected (either
-- direction, any kind). Pair locks are taken up front in sorted order and held to commit, so two runs that
-- judge the same pair at once (nodes saved together) can't both link it, and can't deadlock.
-- p_edges: [{user_id, source_id, target_id, kind, weight, rationale, status, meta}]. Returns inserted ids.
create function mind.insert_link_edges(p_edges jsonb)
returns setof uuid
language plpgsql
set search_path = ''
as $$
declare
  v_pair record;
  v_edge jsonb;
  v_src uuid;
  v_tgt uuid;
  v_id uuid;
begin
  for v_pair in
    select distinct least((e->>'source_id')::uuid, (e->>'target_id')::uuid) as a,
                    greatest((e->>'source_id')::uuid, (e->>'target_id')::uuid) as b
    from jsonb_array_elements(p_edges) e
    order by 1, 2
  loop
    perform pg_advisory_xact_lock(hashtextextended('mind.pair:' || v_pair.a || ':' || v_pair.b, 0));
  end loop;

  for v_edge in select e from jsonb_array_elements(p_edges) e loop
    v_src := (v_edge->>'source_id')::uuid;
    v_tgt := (v_edge->>'target_id')::uuid;
    continue when exists (
      select 1 from mind.edges x
      where (x.source_id = v_src and x.target_id = v_tgt) or (x.source_id = v_tgt and x.target_id = v_src)
    );
    insert into mind.edges (user_id, source_id, target_id, kind, weight, rationale, status, created_by, meta)
    values (
      (v_edge->>'user_id')::uuid, v_src, v_tgt,
      (v_edge->>'kind')::mind.edge_kind,
      (v_edge->>'weight')::real,
      v_edge->>'rationale',
      (v_edge->>'status')::mind.item_status,
      'claude',
      coalesce(v_edge->'meta', '{}'::jsonb)
    )
    on conflict (source_id, target_id, kind) do nothing  -- chat inserted the same edge meanwhile
    returning id into v_id;
    if v_id is not null then
      return next v_id;
    end if;
  end loop;
end;
$$;

revoke execute on function mind.insert_link_edges(jsonb) from public, anon, authenticated;
grant execute on function mind.insert_link_edges(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. link_candidates: new default threshold
-- ---------------------------------------------------------------------------
-- gte-small puts unrelated pairs at ~0.72-0.79 and related ones at ~0.81-0.89, so 0.55 let everything through.
-- 0.78 keeps same-topic pairs (which Haiku should judge, mostly as 'none') and drops clearly unrelated ones.
-- Body unchanged; only the default differs (defaults can be changed in place, not removed).
create or replace function mind.link_candidates(node_id uuid, k int default 10, min_similarity float default 0.78)
returns table (
  id uuid,
  kind mind.node_kind,
  title text,
  body text,
  status mind.item_status,
  similarity float
)
language sql
stable
set search_path = ''
as $$
  with src as (
    select s.id, s.user_id, s.embedding, s.updated_at
    from mind.nodes s
    where s.id = link_candidates.node_id
      and s.embedding is not null
      and s.status in ('active', 'pending')
  )
  select n.id, n.kind, n.title, n.body, n.status,
         ((n.embedding operator(extensions.<#>) src.embedding) * -1)::float as similarity
  from src
  join mind.nodes n
    on n.user_id = src.user_id
   and n.id <> src.id
  where n.embedding is not null
    and n.status in ('active', 'pending')
    and ((n.embedding operator(extensions.<#>) src.embedding) * -1) >= min_similarity
    and not exists (
      select 1 from mind.edges e
      where (e.source_id = src.id and e.target_id = n.id)
         or (e.source_id = n.id and e.target_id = src.id)
    )
    and not exists (
      select 1 from mind.link_checks lc
      where lc.node_a = least(src.id, n.id)
        and lc.node_b = greatest(src.id, n.id)
        and lc.checked_at >= greatest(src.updated_at, n.updated_at)
    )
  order by n.embedding operator(extensions.<#>) src.embedding
  limit k;
$$;

revoke execute on function mind.link_candidates(uuid, int, float) from public, anon;

notify pgrst, 'reload schema';
