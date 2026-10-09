-- Local-only seed: generic sample content, no personal data.
-- Runs after migrations on `supabase db reset`.

-- Local test users (password sign-in: test@example.com / password)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
   'test@example.com', extensions.crypt('password', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
   'other@example.com', extensions.crypt('password', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   '{"sub":"00000000-0000-0000-0000-000000000001","email":"test@example.com","email_verified":true}', 'email', now(), now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002',
   '{"sub":"00000000-0000-0000-0000-000000000002","email":"other@example.com","email_verified":true}', 'email', now(), now(), now())
on conflict do nothing;

-- Embed trigger config (local stack: kong resolves from the db container). Set before nodes so seeds get embedded.
insert into mind.internal_config (key, value) values
  ('functions_url', 'http://kong:8000/functions/v1'),
  ('webhook_secret', 'local-dev-secret')
on conflict (key) do update set value = excluded.value;

insert into mind.settings (user_id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002')
on conflict do nothing;

-- User 1 nodes
insert into mind.nodes (id, user_id, kind, title, body, status, conviction, importance, created_by) values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'theme',    'Health', 'Everything about staying fit and well.', 'active', null, 0.8, 'user'),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'goal',     'Run a half marathon', 'Finish a 21 km race this year.', 'active', null, 0.7, 'user'),
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'plan',     'Train 4x a week', 'Four short runs per week, building distance slowly.', 'active', null, 0.6, 'user'),
  ('a0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'belief',   'Consistency beats intensity', 'Showing up regularly matters more than occasional big efforts.', 'active', 0.9, 0.7, 'user'),
  ('a0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'value',    'Autonomy', 'I want to decide how I spend my time and energy.', 'active', 0.95, 0.9, 'user'),
  ('a0000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'question', 'Should I learn piano or guitar?', 'Undecided between the two instruments.', 'active', null, 0.4, 'user'),
  ('a0000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'project',  'Personal website', 'A small site to share notes and projects.', 'active', null, 0.5, 'user'),
  ('a0000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'theme',    'Creativity', 'Making things for the joy of it.', 'active', null, 0.6, 'user'),
  ('a0000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'idea',     'Write a short story each month', 'A small monthly creative habit.', 'active', null, 0.4, 'user'),
  ('a0000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'belief',   'Intense effort is the only way to improve', 'Progress needs all-out effort; easing off is wasted time.', 'active', 0.5, 0.5, 'user'),
  ('a0000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'idea',     'Buy a standing desk', 'Maybe worth trying for back comfort.', 'active', null, 0.2, 'user'),
  ('a0000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'plan',     'Launch the website by spring', 'Ship a first version with three pages.', 'active', null, 0.5, 'user'),
  ('a0000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'insight',  'I focus best in the morning', 'Deep work goes better before noon.', 'active', 0.7, 0.5, 'user'),
  ('a0000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'person',   'Sample Mentor', 'Someone whose advice shaped my approach to projects.', 'active', null, 0.3, 'user'),
  ('a0000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000001', 'goal',     'Learn a musical instrument', 'Pick up an instrument and play simple songs.', 'active', null, 0.5, 'user')
on conflict (id) do nothing;

-- User 2 nodes (RLS isolation tests)
insert into mind.nodes (id, user_id, kind, title, body, status, created_by) values
  ('b0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'idea', 'Other user idea', 'Belongs to a different user.', 'active', 'user'),
  ('b0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'goal', 'Other user goal', 'Also belongs to a different user.', 'active', 'user')
on conflict (id) do nothing;

-- User 1 edges
insert into mind.edges (id, user_id, source_id, target_id, kind, weight, rationale, status, created_by) values
  ('c0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'serves',        0.8, 'Training advances the race goal', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003', 'supports',      0.8, 'Regular short runs follow from this belief', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'part_of',       0.7, 'A health goal', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000004', 'contradicts',   0.7, 'All-out effort vs steady habit', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000007', 'supports',      0.6, 'Owning my own site expresses autonomy', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000008', 'part_of',       0.6, 'Creative habit', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000014', 'inspired_by',   0.5, 'Mentor suggested the project', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000003', 'supports',      0.5, 'Schedule runs and work around energy', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000015', 'branches_from', 0.6, 'The question grew out of the goal', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000015', 'a0000000-0000-0000-0000-000000000008', 'part_of',       0.6, 'Music is a creative pursuit', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000007', 'part_of',       0.7, 'Milestone of the website project', 'active', 'user'),
  ('c0000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'part_of',       0.5, 'A belief about staying healthy', 'active', 'user')
on conflict (id) do nothing;
