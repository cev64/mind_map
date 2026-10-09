-- Mind Map data layer. Everything lives in schema `mind`.
-- Only objects outside `mind`: extensions vector (schema extensions) and pg_net (functions in schema net),
-- and membership of mind tables in the supabase_realtime publication.

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists vector with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. Schema, enums, tables
-- ---------------------------------------------------------------------------
create schema if not exists mind;

create type mind.node_kind as enum ('idea','belief','value','goal','plan','question','project','person','theme','insight');
create type mind.edge_kind as enum ('branches_from','supports','contradicts','part_of','depends_on','serves','inspired_by','evolved_into','relates_to');
create type mind.item_status as enum ('pending','active','archived','rejected');

create table mind.nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind mind.node_kind not null,
  title text not null,
  body text,
  status mind.item_status not null default 'pending',
  conviction real check (conviction between 0 and 1),
  importance real default 0.5 check (importance between 0 and 1),
  created_by text not null default 'claude' check (created_by in ('user','claude')),
  source_message_id uuid,
  embedding extensions.vector(384),
  embedding_source_hash text,          -- sha256 hex of the text that was embedded; embed fn skips unchanged text
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  content_updated_at timestamptz not null default now(),  -- bumped only by kind/title/body edits; embed's race guard
  last_touched_at timestamptz not null default now()
);

create table mind.edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  source_id uuid not null references mind.nodes on delete cascade,
  target_id uuid not null references mind.nodes on delete cascade,
  kind mind.edge_kind not null,
  weight real default 0.5,
  rationale text,
  status mind.item_status not null default 'pending',
  created_by text not null default 'claude' check (created_by in ('user','claude')),
  meta jsonb not null default '{}',    -- e.g. {"source":"link_suggester"}
  created_at timestamptz not null default now(),
  unique (source_id, target_id, kind),
  check (source_id <> target_id)
);

create table mind.node_history (
  id bigint generated always as identity primary key,
  node_id uuid not null references mind.nodes on delete cascade,
  snapshot jsonb not null,
  changed_by text not null,
  reason text,
  created_at timestamptz not null default now()
);

create table mind.proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  op text not null check (op in ('update_node','merge_nodes','archive_node','retype_edge')),
  payload jsonb not null,
  rationale text,
  status mind.item_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table mind.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create table mind.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references mind.conversations on delete cascade,
  role text not null check (role in ('user','assistant')),
  content jsonb not null,
  created_at timestamptz not null default now()
);

create table mind.self_model (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  content text not null,
  open_questions jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table mind.link_checks (
  node_a uuid not null references mind.nodes on delete cascade,   -- always the smaller uuid
  node_b uuid not null references mind.nodes on delete cascade,   -- always the larger uuid
  result text not null,
  confidence real,
  checked_at timestamptz not null default now(),
  primary key (node_a, node_b),
  check (node_a < node_b)
);

create table mind.settings (
  user_id uuid primary key references auth.users on delete cascade,
  auto_apply boolean not null default false,
  link_suggester boolean not null default true,
  link_auto_accept_confidence real not null default 0.9,
  chat_model text not null default 'claude-sonnet-5-5'
);

-- Environment-specific config for the embed trigger (functions_url, webhook_secret).
-- No rows are inserted here. Readable only by security-definer functions and service_role.
create table mind.internal_config (
  key text primary key,
  value text not null
);

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
create index nodes_embedding_hnsw on mind.nodes using hnsw (embedding extensions.vector_ip_ops);
create index nodes_user_status_kind_idx on mind.nodes (user_id, status, kind);
create index edges_source_id_idx on mind.edges (source_id);
create index edges_target_id_idx on mind.edges (target_id);
create index edges_user_id_idx on mind.edges (user_id);
create index node_history_node_id_idx on mind.node_history (node_id);
create index proposals_user_id_idx on mind.proposals (user_id);
create index conversations_user_id_idx on mind.conversations (user_id);
create index messages_conversation_id_idx on mind.messages (conversation_id);
create index self_model_user_created_idx on mind.self_model (user_id, created_at desc);
create index link_checks_node_b_idx on mind.link_checks (node_b);

-- ---------------------------------------------------------------------------
-- 4. Triggers
-- ---------------------------------------------------------------------------

-- updated_at: bump only when a content column changes (not embedding / hash / last_touched_at).
-- content_updated_at: bump only when the embedded text (kind/title/body) changes.
create function mind.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.kind, new.title, new.body, new.status, new.conviction, new.importance, new.meta)
     is distinct from
     (old.kind, old.title, old.body, old.status, old.conviction, old.importance, old.meta) then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  if (new.kind, new.title, new.body) is distinct from (old.kind, old.title, old.body) then
    new.content_updated_at := now();
  else
    new.content_updated_at := old.content_updated_at;
  end if;
  return new;
end;
$$;

create trigger nodes_set_updated_at
  before update on mind.nodes
  for each row execute function mind.set_updated_at();

-- node_history: snapshot of the OLD row (no embedding) when title/body/conviction/kind change.
create function mind.write_node_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.conviction is distinct from old.conviction
     or new.kind is distinct from old.kind then
    insert into mind.node_history (node_id, snapshot, changed_by)
    values (
      old.id,
      to_jsonb(old) - 'embedding',
      coalesce(
        nullif(current_setting('mind.changed_by', true), ''),
        case when auth.role() = 'service_role' then 'system' else 'user' end
      )
    );
  end if;
  return null;
end;
$$;

create trigger nodes_write_history
  after update on mind.nodes
  for each row execute function mind.write_node_history();

-- Embed webhook: async POST to the embed Edge Function via pg_net.
create function mind.request_embedding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if tg_op = 'UPDATE'
     and not (new.kind is distinct from old.kind
              or new.title is distinct from old.title
              or new.body is distinct from old.body) then
    return null;
  end if;

  select value into v_url from mind.internal_config where key = 'functions_url';
  select value into v_secret from mind.internal_config where key = 'webhook_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;

  begin
    perform net.http_post(
      url := rtrim(v_url, '/') || '/embed',
      body := jsonb_build_object('node_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-mind-webhook-secret', v_secret
      ),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- never block a node write because the webhook could not be queued
    raise warning 'mind.request_embedding failed: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger nodes_request_embedding
  after insert or update of kind, title, body on mind.nodes
  for each row execute function mind.request_embedding();

revoke execute on function mind.set_updated_at() from public, anon, authenticated;
revoke execute on function mind.write_node_history() from public, anon, authenticated;
revoke execute on function mind.request_embedding() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPC functions (security invoker: RLS scopes results to the caller)
-- ---------------------------------------------------------------------------

create function mind.match_nodes(
  query_embedding extensions.vector(384),
  match_threshold float,
  match_count int,
  kinds mind.node_kind[] default null
)
returns table (
  id uuid,
  kind mind.node_kind,
  title text,
  body text,
  status mind.item_status,
  importance real,
  similarity float
)
language sql
stable
set search_path = ''
as $$
  select n.id, n.kind, n.title, n.body, n.status, n.importance,
         ((n.embedding operator(extensions.<#>) query_embedding) * -1)::float as similarity
  from mind.nodes n
  where n.embedding is not null
    and n.status not in ('rejected', 'archived')
    and (kinds is null or n.kind = any (kinds))
    and ((n.embedding operator(extensions.<#>) query_embedding) * -1) >= match_threshold
  order by n.embedding operator(extensions.<#>) query_embedding
  limit match_count;
$$;

create function mind.get_neighborhood(root_ids uuid[], depth int default 2)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with recursive walk(id, d) as (
    select n.id, 0
    from mind.nodes n
    where n.id = any (root_ids)
      and n.status not in ('rejected', 'archived')
    union
    select (case when e.source_id = w.id then e.target_id else e.source_id end), w.d + 1
    from walk w
    join mind.edges e
      on (e.source_id = w.id or e.target_id = w.id)
     and e.status not in ('rejected', 'archived')
    join mind.nodes nn
      on nn.id = (case when e.source_id = w.id then e.target_id else e.source_id end)
     and nn.status not in ('rejected', 'archived')
    where w.d < least(depth, 3)
  ),
  ids as (select distinct id from walk)
  select jsonb_build_object(
    'nodes', coalesce((
      select jsonb_agg(to_jsonb(n) - 'embedding' order by n.created_at, n.id)
      from mind.nodes n where n.id in (select id from ids)
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from mind.edges e
      where e.status not in ('rejected', 'archived')
        and e.source_id in (select id from ids)
        and e.target_id in (select id from ids)
    ), '[]'::jsonb)
  );
$$;

create function mind.link_candidates(node_id uuid, k int default 10, min_similarity float default 0.55)
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

create function mind.graph_snapshot()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'nodes', coalesce((
      select jsonb_agg(to_jsonb(n) - 'embedding' order by n.created_at, n.id)
      from mind.nodes n
      where n.status in ('active', 'pending')
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from mind.edges e
      join mind.nodes s on s.id = e.source_id and s.status in ('active', 'pending')
      join mind.nodes t on t.id = e.target_id and t.status in ('active', 'pending')
      where e.status in ('active', 'pending')
    ), '[]'::jsonb)
  );
$$;

create function mind.find_tensions()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'contradictions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'edge_id', e.id,
        'source_id', s.id, 'source_title', s.title,
        'target_id', t.id, 'target_title', t.title,
        'rationale', e.rationale,
        'status', e.status
      ) order by e.created_at, e.id)
      from mind.edges e
      join mind.nodes s on s.id = e.source_id and s.status in ('active', 'pending')
      join mind.nodes t on t.id = e.target_id and t.status in ('active', 'pending')
      where e.kind = 'contradicts' and e.status in ('active', 'pending')
    ), '[]'::jsonb),
    'unsupported_plans', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title) order by n.created_at, n.id)
      from mind.nodes n
      where n.kind = 'plan' and n.status in ('active', 'pending')
        and not exists (
          select 1 from mind.edges e
          where e.status in ('active', 'pending')
            and ((e.kind = 'supports' and e.target_id = n.id)
              or (e.kind = 'serves' and e.source_id = n.id))
        )
    ), '[]'::jsonb),
    'goals_without_plans', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title) order by n.created_at, n.id)
      from mind.nodes n
      where n.kind = 'goal' and n.status in ('active', 'pending')
        and not exists (
          select 1 from mind.edges e
          join mind.nodes p on p.id = e.source_id and p.kind = 'plan' and p.status in ('active', 'pending')
          where e.kind = 'serves' and e.target_id = n.id and e.status in ('active', 'pending')
        )
    ), '[]'::jsonb),
    'orphans', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title) order by n.created_at, n.id)
      from mind.nodes n
      where n.status in ('active', 'pending')
        and not exists (
          select 1 from mind.edges e
          where e.status in ('active', 'pending')
            and (e.source_id = n.id or e.target_id = n.id)
        )
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Row level security
-- ---------------------------------------------------------------------------
alter table mind.nodes enable row level security;
alter table mind.edges enable row level security;
alter table mind.node_history enable row level security;
alter table mind.proposals enable row level security;
alter table mind.conversations enable row level security;
alter table mind.messages enable row level security;
alter table mind.self_model enable row level security;
alter table mind.link_checks enable row level security;
alter table mind.settings enable row level security;
alter table mind.internal_config enable row level security;  -- no policies on purpose

-- nodes
create policy nodes_select on mind.nodes for select to authenticated
  using (user_id = (select auth.uid()));
create policy nodes_insert on mind.nodes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy nodes_update on mind.nodes for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy nodes_delete on mind.nodes for delete to authenticated
  using (user_id = (select auth.uid()));

-- edges (both endpoints must be the caller's nodes)
create policy edges_select on mind.edges for select to authenticated
  using (user_id = (select auth.uid()));
create policy edges_insert on mind.edges for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from mind.nodes n where n.id = source_id and n.user_id = (select auth.uid()))
    and exists (select 1 from mind.nodes n where n.id = target_id and n.user_id = (select auth.uid()))
  );
create policy edges_update on mind.edges for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from mind.nodes n where n.id = source_id and n.user_id = (select auth.uid()))
    and exists (select 1 from mind.nodes n where n.id = target_id and n.user_id = (select auth.uid()))
  );
create policy edges_delete on mind.edges for delete to authenticated
  using (user_id = (select auth.uid()));

-- node_history: read-only for the node's owner (rows come from the security-definer trigger)
create policy node_history_select on mind.node_history for select to authenticated
  using (exists (select 1 from mind.nodes n where n.id = node_id and n.user_id = (select auth.uid())));

-- proposals
create policy proposals_select on mind.proposals for select to authenticated
  using (user_id = (select auth.uid()));
create policy proposals_insert on mind.proposals for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy proposals_update on mind.proposals for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- conversations
create policy conversations_select on mind.conversations for select to authenticated
  using (user_id = (select auth.uid()));
create policy conversations_insert on mind.conversations for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy conversations_update on mind.conversations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy conversations_delete on mind.conversations for delete to authenticated
  using (user_id = (select auth.uid()));

-- messages: via conversation owner
create policy messages_select on mind.messages for select to authenticated
  using (exists (select 1 from mind.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));
create policy messages_insert on mind.messages for insert to authenticated
  with check (exists (select 1 from mind.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));

-- self_model: owner read-only (written by service role)
create policy self_model_select on mind.self_model for select to authenticated
  using (user_id = (select auth.uid()));

-- link_checks: via node_a / node_b owner
create policy link_checks_select on mind.link_checks for select to authenticated
  using (exists (select 1 from mind.nodes n where n.id = node_a and n.user_id = (select auth.uid())));
create policy link_checks_insert on mind.link_checks for insert to authenticated
  with check (
    exists (select 1 from mind.nodes n where n.id = node_a and n.user_id = (select auth.uid()))
    and exists (select 1 from mind.nodes n where n.id = node_b and n.user_id = (select auth.uid()))
  );
create policy link_checks_update on mind.link_checks for update to authenticated
  using (exists (select 1 from mind.nodes n where n.id = node_a and n.user_id = (select auth.uid())))
  with check (
    exists (select 1 from mind.nodes n where n.id = node_a and n.user_id = (select auth.uid()))
    and exists (select 1 from mind.nodes n where n.id = node_b and n.user_id = (select auth.uid()))
  );

-- settings
create policy settings_select on mind.settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy settings_insert on mind.settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy settings_update on mind.settings for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 7. Grants (nothing for anon)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema mind from public, anon, authenticated;
revoke all on all sequences in schema mind from public, anon, authenticated;
revoke all on all functions in schema mind from public, anon;

grant usage on schema mind to authenticated, service_role;

grant select, insert, update, delete on mind.nodes to authenticated;
grant select, insert, update, delete on mind.edges to authenticated;
grant select on mind.node_history to authenticated;
grant select, insert, update on mind.proposals to authenticated;
grant select, insert, update, delete on mind.conversations to authenticated;
grant select, insert on mind.messages to authenticated;
grant select on mind.self_model to authenticated;
grant select, insert, update on mind.link_checks to authenticated;
grant select, insert, update on mind.settings to authenticated;
-- internal_config: no grant to authenticated

grant all on all tables in schema mind to service_role;
grant all on all sequences in schema mind to service_role;
grant usage on all sequences in schema mind to authenticated;

grant execute on function mind.match_nodes(extensions.vector, float, int, mind.node_kind[]) to authenticated, service_role;
grant execute on function mind.get_neighborhood(uuid[], int) to authenticated, service_role;
grant execute on function mind.link_candidates(uuid, int, float) to authenticated, service_role;
grant execute on function mind.graph_snapshot() to authenticated, service_role;
grant execute on function mind.find_tensions() to authenticated, service_role;

-- future objects in mind get no implicit grants for API roles
alter default privileges in schema mind revoke all on tables from anon, authenticated;
-- Functions: PUBLIC's default EXECUTE is global and can't be revoked per schema, so every
-- migration that adds a function in mind must revoke execute from public, anon explicitly.

-- ---------------------------------------------------------------------------
-- 8. Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table mind.nodes, mind.edges, mind.proposals;
