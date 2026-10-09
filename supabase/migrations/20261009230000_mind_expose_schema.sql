-- Expose `mind` to the Data API (PostgREST) on the hosted project.
-- The Budget project already sets pgrst.db_schemas on the authenticator role for other apps
-- (e.g. 'public, graphql_public, betting, claudehub'); append `mind` to whatever is there so
-- those schemas stay exposed. Locally there is no such setting (supabase/config.toml [api]
-- schemas exposes `mind`), so this is a no-op.
do $$
declare
  current_schemas text;
begin
  select substring(cfg from '^pgrst\.db_schemas=(.*)$')
    into current_schemas
  from pg_db_role_setting s
  join pg_roles r on r.oid = s.setrole and r.rolname = 'authenticator'
  cross join lateral unnest(s.setconfig) as cfg
  where s.setdatabase = 0 and cfg like 'pgrst.db_schemas=%';

  if current_schemas is not null
     and not ('mind' = any (string_to_array(replace(current_schemas, ' ', ''), ','))) then
    execute format('alter role authenticator set pgrst.db_schemas = %L', current_schemas || ', mind');
    notify pgrst, 'reload config';
  end if;
end;
$$;
