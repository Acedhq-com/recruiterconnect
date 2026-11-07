-- LOCAL DISPOSABLE DATABASE ONLY. This fixture is not Supabase Auth.
-- It implements only the columns and JWT-GUC accessors used by this repository.
-- Run in a new empty database as its local owner, before the real migrations.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$roles$;
create schema auth;
create table auth.users (
  id uuid primary key,
  aud text,
  role text,
  email text,
  email_confirmed_at timestamptz,
  is_anonymous boolean not null default false,
  deleted_at timestamptz,
  banned_until timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz,
  updated_at timestamptz,
  not_after timestamptz
);
create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt()->>'sub', '')::uuid;
$$;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
