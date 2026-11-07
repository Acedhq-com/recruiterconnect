-- Additive private-account foundation. This does not enable recruiter discovery.
create schema if not exists fwp_private;
revoke all on schema fwp_private from public, anon, authenticated;

create function fwp_private.session_is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join auth.sessions s on s.user_id = u.id
    where u.id = auth.uid() and u.email_confirmed_at is not null
      and u.email is not null and not u.is_anonymous and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now())
      and s.id::text = (auth.jwt() ->> 'session_id')
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function fwp_private.session_is_active() from public, anon, authenticated;
grant usage on schema fwp_private to authenticated;
grant execute on function fwp_private.session_is_active() to authenticated;

create table public.member_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_kind text not null check (account_kind in ('candidate', 'recruiter')),
  display_name text not null check (length(display_name) between 2 and 80),
  status text not null default 'active' check (status in ('active', 'deletion_requested', 'suspended')),
  deletion_requested_at timestamptz,
  beta_notice_version text not null default 'private-accounts-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.account_profiles (
  user_id uuid primary key references public.member_accounts(user_id) on delete cascade,
  headline text not null default '' check (length(headline) <= 120),
  skills text[] not null default '{}'::text[] check (cardinality(skills) <= 12),
  work_preference text not null default 'Remote' check (work_preference in ('Remote', 'Hybrid', 'On-site')),
  discovery_active boolean not null default false,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default now()
);
alter table public.member_accounts enable row level security;
alter table public.account_profiles enable row level security;
revoke all on public.member_accounts, public.account_profiles from public, anon, authenticated;
grant select on public.member_accounts, public.account_profiles to authenticated;
create policy account_owner_read on public.member_accounts for select to authenticated
  using ((select auth.uid()) = user_id and (select fwp_private.session_is_active()));
create policy profile_owner_read on public.account_profiles for select to authenticated
  using ((select auth.uid()) = user_id and (select fwp_private.session_is_active()));

create function fwp_private.verified_user_id() returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not fwp_private.session_is_active() then
    raise exception 'Verified sign-in required' using errcode = '42501';
  end if;
  return actor;
end;
$$;
revoke all on function fwp_private.verified_user_id() from public, anon, authenticated;

create function public.onboard_my_account(p_kind text, p_display_name text, p_beta_ack boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := fwp_private.verified_user_id(); existing_kind text; existing_status text;
begin
  if p_beta_ack is distinct from true
    or p_kind is null or p_kind not in ('candidate', 'recruiter')
    or p_display_name is null or length(trim(p_display_name)) not between 2 and 80
    or p_display_name ~ '[[:cntrl:]]'
  then raise exception 'Invalid account details' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text, 0));
  select account_kind, status into existing_kind, existing_status
    from public.member_accounts where user_id = actor;
  if existing_status is not null and existing_status <> 'active' then
    raise exception 'Account is not active' using errcode = '42501';
  end if;
  if existing_kind is not null and existing_kind <> p_kind then
    raise exception 'Account type is already set' using errcode = '22023';
  end if;
  insert into public.member_accounts(user_id, account_kind, display_name)
    values (actor, p_kind, trim(p_display_name)) on conflict (user_id) do nothing;
  if p_kind = 'candidate' then
    insert into public.account_profiles(user_id) values (actor) on conflict (user_id) do nothing;
  end if;
end;
$$;

create function public.save_my_private_profile(
  p_display_name text, p_headline text, p_skills text[],
  p_work_preference text, p_expected_version bigint
) returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := fwp_private.verified_user_id();
begin
  if not exists (select 1 from public.member_accounts
    where user_id = actor and account_kind = 'candidate' and status = 'active')
  then raise exception 'An active candidate account is required' using errcode = '42501'; end if;
  if p_display_name is null or length(trim(p_display_name)) not between 2 and 80
    or p_headline is null or length(trim(p_headline)) not between 2 and 120
    or p_display_name ~ '[[:cntrl:]]' or p_headline ~ '[[:cntrl:]]'
    or p_skills is null or cardinality(p_skills) > 12
    or exists (select 1 from unnest(p_skills) s where s is null
      or length(trim(s)) not between 1 and 40 or s ~ '[[:cntrl:]]')
    or p_work_preference is null or p_work_preference not in ('Remote', 'Hybrid', 'On-site')
    or p_expected_version is null or p_expected_version < 1
  then raise exception 'Invalid private profile' using errcode = '22023'; end if;
  update public.account_profiles set headline = trim(p_headline),
    skills = array(select trim(s) from unnest(p_skills) s),
    work_preference = p_work_preference, version = version + 1, updated_at = now()
    where user_id = actor and version = p_expected_version;
  if not found then raise exception 'Profile changed; reload and retry' using errcode = '40001'; end if;
  update public.member_accounts set display_name = trim(p_display_name), updated_at = now()
    where user_id = actor;
  -- discovery_active is deliberately not updated by this function.
end;
$$;

create function public.request_my_account_deletion() returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := fwp_private.verified_user_id();
begin
  update public.member_accounts set status = 'deletion_requested',
    deletion_requested_at = now(), updated_at = now()
    where user_id = actor and status in ('active', 'deletion_requested');
  if not found then raise exception 'Account not available for this action' using errcode = '42501'; end if;
  update public.account_profiles set discovery_active = false, updated_at = now()
    where user_id = actor;
end;
$$;

create function public.cancel_my_account_deletion() returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := fwp_private.verified_user_id();
begin
  update public.member_accounts set status = 'active',
    deletion_requested_at = null, updated_at = now()
    where user_id = actor and status = 'deletion_requested';
  if not found then raise exception 'No cancellable deletion request' using errcode = '42501'; end if;
end;
$$;

revoke all on function public.onboard_my_account(text,text,boolean) from public, anon, authenticated;
revoke all on function public.save_my_private_profile(text,text,text[],text,bigint) from public, anon, authenticated;
revoke all on function public.request_my_account_deletion() from public, anon, authenticated;
revoke all on function public.cancel_my_account_deletion() from public, anon, authenticated;
grant execute on function public.onboard_my_account(text,text,boolean) to authenticated;
grant execute on function public.save_my_private_profile(text,text,text[],text,bigint) to authenticated;
grant execute on function public.request_my_account_deletion() to authenticated;
grant execute on function public.cancel_my_account_deletion() to authenticated;

create function public.account_session_active() returns boolean
language sql stable security invoker set search_path = '' as $$
  select fwp_private.session_is_active();
$$;
revoke all on function public.account_session_active() from public, anon, authenticated;
grant execute on function public.account_session_active() to authenticated;

comment on table public.member_accounts is 'Private, verified-email accounts. Self-selected account_kind is not recruiter verification or an admin role.';
comment on table public.account_profiles is 'Owner-only candidate drafts. Client writes cannot enable discovery. Production recruiting authorization is a separate launch stage.';
