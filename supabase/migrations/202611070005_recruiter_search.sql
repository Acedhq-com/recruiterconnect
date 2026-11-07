-- Phase 2: recruiter profiles, owner verification, consented candidate
-- discovery, and anonymous search with the candidate block list enforced inside
-- the database.
--
-- This replaces the earlier rule that nothing could ever make a candidate
-- discoverable. The replacement is deliberately narrow:
--   * a candidate must switch discoverability on themselves, with a consent
--     version the database checks, and the operator must approve the profile;
--   * only an operator-verified recruiter with a non-empty hires-for list can
--     search, and every result is filtered against the candidate's block list;
--   * search returns four columns (handle, headline, skills, work preference),
--     never a name, email, employer, user id or block;
--   * there is no way to contact anyone yet (introductions are a later phase).
-- Operator actions are functions in the private schema that PostgREST does not
-- expose and no client role can execute.
begin;

-- ---------------------------------------------------------------------------
-- Company matching beyond the normalized name: operator-maintained aliases and
-- a word-boundary prefix rule ("kpmg" matches "kpmg us"; "acme" does not match
-- "acmeron"). Errs toward hiding more, never less.
-- ---------------------------------------------------------------------------
create table fwp_private.company_aliases (
  alias_key text primary key check (length(alias_key) between 2 and 150),
  canonical_key text not null check (length(canonical_key) between 2 and 150),
  created_at timestamptz not null default now(),
  check (alias_key <> canonical_key)
);
revoke all on fwp_private.company_aliases from public, anon, authenticated;

create function fwp_private.canonical_company(p_key text) returns text
language sql stable set search_path = pg_catalog as $$
  select coalesce((select a.canonical_key from fwp_private.company_aliases a
    where a.alias_key = p_key), p_key);
$$;

-- Both arguments must already be canonical. Unusable input counts as a conflict
-- so a malformed key can only ever hide a candidate, not expose one.
create function fwp_private.canonical_keys_conflict(p_a text, p_b text) returns boolean
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if p_a is null or p_b is null or length(p_a) < 2 or length(p_b) < 2 then return true; end if;
  return p_a = p_b
    or left(p_a, length(p_b) + 1) = p_b || ' '
    or left(p_b, length(p_a) + 1) = p_a || ' ';
end;
$$;

-- ---------------------------------------------------------------------------
-- Recruiter side
-- ---------------------------------------------------------------------------
create table public.recruiter_profiles (
  user_id uuid primary key references public.member_accounts(user_id) on delete cascade,
  firm_name text not null check (length(firm_name) between 2 and 150),
  firm_key text not null check (length(firm_key) between 2 and 150),
  proof_url text check (proof_url is null
    or (length(proof_url) between 12 and 300 and proof_url ~ '^https://[^[:space:][:cntrl:]]+$')),
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'verified', 'rejected', 'suspended')),
  submitted_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.recruiter_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.recruiter_profiles(user_id) on delete cascade,
  company_name text not null check (length(company_name) between 2 and 150),
  company_key text not null check (length(company_key) between 2 and 150),
  created_at timestamptz not null default now(),
  unique (user_id, company_key)
);

-- ---------------------------------------------------------------------------
-- Candidate side: explicit consent plus operator review. The older
-- account_profiles.discovery_active column is left untouched and unused; it
-- stays false and this table is the only source of truth for discoverability.
-- ---------------------------------------------------------------------------
create table public.candidate_discovery (
  user_id uuid primary key references public.member_accounts(user_id) on delete cascade,
  handle text not null unique
    default ('RC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  enabled boolean not null default false,
  consent_version text,
  consented_at timestamptz,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected', 'suspended')),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.recruiter_profiles enable row level security;
alter table public.recruiter_clients enable row level security;
alter table public.candidate_discovery enable row level security;
revoke all on public.recruiter_profiles, public.recruiter_clients, public.candidate_discovery
  from public, anon, authenticated;
grant select on public.recruiter_profiles, public.recruiter_clients, public.candidate_discovery
  to authenticated;
create policy recruiter_profiles_owner_read on public.recruiter_profiles for select to authenticated
  using ((select auth.uid()) = user_id and (select fwp_private.session_is_active()));
create policy recruiter_clients_owner_read on public.recruiter_clients for select to authenticated
  using ((select auth.uid()) = user_id and (select fwp_private.session_is_active()));
create policy candidate_discovery_owner_read on public.candidate_discovery for select to authenticated
  using ((select auth.uid()) = user_id and (select fwp_private.session_is_active()));

-- Operator-only records. No client role can read or write either table.
create table fwp_private.search_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.member_accounts(user_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index search_log_recent on fwp_private.search_log (user_id, created_at);
create table fwp_private.review_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  kind text not null check (kind in ('recruiter', 'candidate')),
  from_status text,
  to_status text not null,
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now()
);
revoke all on fwp_private.search_log, fwp_private.review_log from public, anon, authenticated;

-- The audit log gains event names only; it still holds no company names.
alter table fwp_private.privacy_audit drop constraint privacy_audit_event_check;
alter table fwp_private.privacy_audit add constraint privacy_audit_event_check check (event in (
  'current_employer_set', 'block_added', 'block_removed',
  'discovery_enabled', 'discovery_disabled',
  'recruiter_firm_saved', 'recruiter_client_added', 'recruiter_client_removed',
  'recruiter_submitted', 'recruiter_verified', 'recruiter_rejected',
  'recruiter_suspended', 'recruiter_reopened',
  'candidate_approved', 'candidate_rejected', 'candidate_suspended', 'candidate_reopened'));

-- ---------------------------------------------------------------------------
-- Shared rules
-- ---------------------------------------------------------------------------
create function fwp_private.current_discovery_consent() returns text
language sql immutable set search_path = pg_catalog as $$ select 'discovery-v1'::text; $$;

-- Does free text (a headline or skills line) name a company the candidate blocks?
create function fwp_private.text_mentions_block(p_user uuid, p_text text) returns boolean
language sql stable set search_path = pg_catalog as $$
  select exists (
    select 1 from public.candidate_blocks b
    where position(' ' || b.company_key || ' '
      in ' ' || fwp_private.normalize_company(p_text) || ' ') > 0);
$$;

-- Things the candidate controls and can fix. Empty means ready to be switched on.
create function fwp_private.candidate_readiness(p_user uuid) returns text[]
language plpgsql stable set search_path = pg_catalog as $$
declare reasons text[] := '{}'; prof record; has_profile boolean;
begin
  select a.headline, a.skills into prof from public.account_profiles a where a.user_id = p_user;
  has_profile := found;
  if not has_profile or length(btrim(prof.headline)) < 2 then
    reasons := array_append(reasons, 'profile_incomplete');
  end if;
  if not exists (select 1 from public.candidate_private c where c.user_id = p_user) then
    reasons := array_append(reasons, 'employer_missing');
  end if;
  if has_profile and fwp_private.text_mentions_block(p_user,
    prof.headline || ' , ' || array_to_string(prof.skills, ' , ')) then
    reasons := array_append(reasons, 'mentions_blocked_company');
  end if;
  return reasons;
end;
$$;

-- The single definition of "a recruiter may see this candidate". Search and the
-- candidate's own status screen both use it. Empty means visible.
create function fwp_private.candidate_blockers(p_user uuid) returns text[]
language plpgsql stable security definer set search_path = pg_catalog as $$
declare reasons text[]; disc record; has_disc boolean;
begin
  if not exists (
    select 1 from public.member_accounts m
    join auth.users u on u.id = m.user_id
    where m.user_id = p_user and m.account_kind = 'candidate' and m.status = 'active'
      and u.email_confirmed_at is not null and not u.is_anonymous and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= clock_timestamp())
  ) then
    return array['account_inactive'];
  end if;
  select d.enabled, d.consent_version, d.review_status into disc
    from public.candidate_discovery d where d.user_id = p_user;
  has_disc := found;
  reasons := fwp_private.candidate_readiness(p_user);
  if not has_disc or not disc.enabled then
    reasons := array_append(reasons, 'not_enabled');
  elsif disc.consent_version is distinct from fwp_private.current_discovery_consent() then
    reasons := array_append(reasons, 'consent_outdated');
  end if;
  if has_disc then
    reasons := reasons || case disc.review_status
      when 'approved' then '{}'::text[]
      when 'rejected' then array['review_rejected']::text[]
      when 'suspended' then array['review_suspended']::text[]
      else array['awaiting_review']::text[] end;
  end if;
  return reasons;
end;
$$;

-- Does any company the recruiter works for (their firm or their hires-for list)
-- match anything on the candidate's block list, after aliases?
create function fwp_private.recruiter_blocked_by(p_candidate uuid, p_recruiter uuid) returns boolean
language sql stable set search_path = pg_catalog as $$
  with r as (
    select fwp_private.canonical_company(x.key) as k from (
      select p.firm_key as key from public.recruiter_profiles p where p.user_id = p_recruiter
      union
      select c.company_key from public.recruiter_clients c where c.user_id = p_recruiter) x),
  b as (
    select fwp_private.canonical_company(blk.company_key) as k
    from public.candidate_blocks blk where blk.user_id = p_candidate)
  select exists (select 1 from b join r on fwp_private.canonical_keys_conflict(b.k, r.k));
$$;

-- Lock order matches the earlier writers: auth.users -> auth.sessions ->
-- member_accounts -> recruiter_profiles.
create function fwp_private.recruiter_editor() returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.verified_user_id();
begin
  perform 1 from public.member_accounts
    where user_id = actor and account_kind = 'recruiter' and status = 'active' for update;
  if not found then
    raise exception 'An active recruiter account is required' using errcode = '42501';
  end if;
  return actor;
end;
$$;

-- Verified, active, with a firm and a non-empty hires-for list. Fails closed
-- with one message so the caller cannot tell which condition failed.
create function fwp_private.recruiter_actor() returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.verified_user_id();
begin
  perform 1 from public.member_accounts
    where user_id = actor and account_kind = 'recruiter' and status = 'active' for share;
  if found then
    perform 1 from public.recruiter_profiles p
      where p.user_id = actor and p.status = 'verified' and length(p.firm_key) >= 2
        and exists (select 1 from public.recruiter_clients c where c.user_id = actor)
      for share;
  end if;
  if not found then
    raise exception 'A verified recruiter account is required' using errcode = '42501';
  end if;
  return actor;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recruiter writers
-- ---------------------------------------------------------------------------
create function public.save_my_recruiter_firm(p_firm text, p_proof_url text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.recruiter_editor(); clean text; new_key text; url text; cur record;
begin
  if p_firm is null then raise exception 'Invalid firm' using errcode = '22023'; end if;
  clean := btrim(p_firm);
  new_key := fwp_private.normalize_company(clean);
  url := nullif(btrim(coalesce(p_proof_url, '')), '');
  if length(clean) not between 2 and 150 or clean ~ '[[:cntrl:]]'
    or length(new_key) not between 2 and 150
    or (url is not null and (length(url) not between 12 and 300
      or url !~ '^https://[^[:space:][:cntrl:]]+$'))
  then raise exception 'Invalid firm' using errcode = '22023'; end if;
  select p.firm_key, p.proof_url, p.status into cur
    from public.recruiter_profiles p where p.user_id = actor for update;
  if found and cur.status = 'suspended' then
    raise exception 'This recruiter profile is paused' using errcode = '42501';
  end if;
  if not found then
    insert into public.recruiter_profiles(user_id, firm_name, firm_key, proof_url)
      values (actor, clean, new_key, url);
  elsif cur.firm_key = new_key and cur.proof_url is not distinct from url then
    -- Same firm and link: only the display spelling changed. Status is kept.
    update public.recruiter_profiles set firm_name = clean, updated_at = now() where user_id = actor;
    return;
  else
    -- Any substantive change withdraws verification until the operator re-reviews.
    update public.recruiter_profiles set firm_name = clean, firm_key = new_key, proof_url = url,
      status = 'draft', submitted_at = null, verified_at = null, updated_at = now()
      where user_id = actor;
  end if;
  insert into fwp_private.privacy_audit(user_id, event) values (actor, 'recruiter_firm_saved');
end;
$$;

create function public.add_my_client(p_company text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.recruiter_editor(); clean text; new_key text; cur_status text;
begin
  if p_company is null then raise exception 'Invalid company' using errcode = '22023'; end if;
  clean := btrim(p_company);
  new_key := fwp_private.normalize_company(clean);
  if length(clean) not between 2 and 150 or clean ~ '[[:cntrl:]]'
    or length(new_key) not between 2 and 150
  then raise exception 'Invalid company' using errcode = '22023'; end if;
  select p.status into cur_status from public.recruiter_profiles p where p.user_id = actor for update;
  if not found then raise exception 'Save your firm first' using errcode = '22023'; end if;
  if cur_status = 'suspended' then
    raise exception 'This recruiter profile is paused' using errcode = '42501';
  end if;
  if exists (select 1 from public.recruiter_clients where user_id = actor and company_key = new_key) then
    return;
  end if;
  if (select count(*) from public.recruiter_clients where user_id = actor) >= 30 then
    raise exception 'Hires-for list is full' using errcode = '54000';
  end if;
  insert into public.recruiter_clients(user_id, company_name, company_key)
    values (actor, clean, new_key);
  update public.recruiter_profiles set status = 'draft', submitted_at = null, verified_at = null,
    updated_at = now() where user_id = actor;
  insert into fwp_private.privacy_audit(user_id, event) values (actor, 'recruiter_client_added');
end;
$$;

create function public.remove_my_client(p_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.recruiter_editor(); cur_status text;
begin
  if p_id is null then raise exception 'Invalid company' using errcode = '22023'; end if;
  select p.status into cur_status from public.recruiter_profiles p where p.user_id = actor for update;
  if not found then return; end if;
  if cur_status = 'suspended' then
    raise exception 'This recruiter profile is paused' using errcode = '42501';
  end if;
  delete from public.recruiter_clients where id = p_id and user_id = actor;
  if not found then return; end if;
  update public.recruiter_profiles set status = 'draft', submitted_at = null, verified_at = null,
    updated_at = now() where user_id = actor;
  insert into fwp_private.privacy_audit(user_id, event) values (actor, 'recruiter_client_removed');
end;
$$;

create function public.submit_my_recruiter_profile() returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.recruiter_editor(); cur record;
begin
  select p.status, p.proof_url into cur from public.recruiter_profiles p
    where p.user_id = actor for update;
  if not found then raise exception 'Save your firm first' using errcode = '22023'; end if;
  if cur.status = 'suspended' then
    raise exception 'This recruiter profile is paused' using errcode = '42501';
  end if;
  if cur.status in ('pending', 'verified') then return; end if;
  if cur.status = 'rejected' then
    raise exception 'Update your details before applying again' using errcode = '55000';
  end if;
  if cur.proof_url is null
    or not exists (select 1 from public.recruiter_clients where user_id = actor)
  then raise exception 'Add a link and at least one company you recruit for' using errcode = '22023'; end if;
  update public.recruiter_profiles set status = 'pending', submitted_at = now(), updated_at = now()
    where user_id = actor;
  insert into fwp_private.privacy_audit(user_id, event) values (actor, 'recruiter_submitted');
end;
$$;

-- ---------------------------------------------------------------------------
-- Candidate consent
-- ---------------------------------------------------------------------------
create function public.set_my_discovery(p_enabled boolean, p_consent_version text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.privacy_actor();
begin
  if p_enabled is null then raise exception 'Invalid request' using errcode = '22023'; end if;
  if p_enabled then
    if p_consent_version is distinct from fwp_private.current_discovery_consent() then
      raise exception 'Review and confirm the current consent again' using errcode = '22023';
    end if;
    if cardinality(fwp_private.candidate_readiness(actor)) > 0 then
      raise exception 'Finish your private draft first' using errcode = '55000';
    end if;
    insert into public.candidate_discovery(user_id, enabled, consent_version, consented_at)
      values (actor, true, p_consent_version, now())
      on conflict (user_id) do update set enabled = true,
        consent_version = excluded.consent_version, consented_at = now(), updated_at = now();
    insert into fwp_private.privacy_audit(user_id, event) values (actor, 'discovery_enabled');
  else
    update public.candidate_discovery set enabled = false, updated_at = now()
      where user_id = actor and enabled;
    if found then
      insert into fwp_private.privacy_audit(user_id, event) values (actor, 'discovery_disabled');
    end if;
  end if;
end;
$$;

create function public.my_discovery_status() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.verified_user_id(); disc record; blockers text[];
begin
  blockers := fwp_private.candidate_blockers(actor);
  select d.handle, d.enabled, d.consent_version, d.review_status into disc
    from public.candidate_discovery d where d.user_id = actor;
  return jsonb_build_object(
    'enabled', coalesce(disc.enabled, false),
    'review_status', coalesce(disc.review_status, 'pending'),
    'handle', disc.handle,
    'consent_version', disc.consent_version,
    'current_consent_version', fwp_private.current_discovery_consent(),
    'ready', blockers is not null and not blockers && array['account_inactive', 'profile_incomplete',
      'employer_missing', 'mentions_blocked_company'],
    'visible', cardinality(blockers) = 0,
    'blockers', to_jsonb(blockers));
end;
$$;

-- A candidate leaving the active state is hidden at once, and coming back does
-- not silently restore visibility: consent has to be given again.
create function fwp_private.hide_candidate_when_inactive() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if old.status = 'active' and new.status is distinct from 'active' then
    update public.candidate_discovery set enabled = false, updated_at = now()
      where user_id = new.user_id and enabled;
    if found then
      insert into fwp_private.privacy_audit(user_id, event) values (new.user_id, 'discovery_disabled');
    end if;
  end if;
  return new;
end;
$$;
create trigger hide_candidate_when_inactive after update of status on public.member_accounts
  for each row execute function fwp_private.hide_candidate_when_inactive();

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------
create function public.search_candidates(
  p_query text default null, p_work_preference text default null,
  p_limit integer default 20, p_offset integer default 0
) returns table (handle text, headline text, skills text[], work_preference text)
language plpgsql security definer set search_path = pg_catalog as $$
#variable_conflict use_column
declare actor uuid; q text; used integer; tokens text[];
begin
  actor := fwp_private.recruiter_actor();
  q := nullif(btrim(coalesce(p_query, '')), '');
  if (q is not null and (length(q) > 80 or q ~ '[[:cntrl:]]'))
    or (p_work_preference is not null and p_work_preference not in ('Remote', 'Hybrid', 'On-site'))
    or p_limit is null or p_limit not between 1 and 20
    or p_offset is null or p_offset not between 0 and 100
  then raise exception 'Invalid search' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':search', 0));
  select count(*) into used from fwp_private.search_log l
    where l.user_id = actor and l.created_at > clock_timestamp() - interval '1 hour';
  if used >= 60 then raise exception 'Search limit reached' using errcode = '53400'; end if;
  insert into fwp_private.search_log(user_id) values (actor);
  tokens := case when q is null then '{}'::text[]
    else array(select t from unnest(string_to_array(lower(q), ' ')) t where t <> '') end;
  return query
    select d.handle, a.headline, a.skills, a.work_preference
    from public.candidate_discovery d
    join public.account_profiles a on a.user_id = d.user_id
    where cardinality(fwp_private.candidate_blockers(d.user_id)) = 0
      and not fwp_private.recruiter_blocked_by(d.user_id, actor)
      and (p_work_preference is null or a.work_preference = p_work_preference)
      and not exists (
        select 1 from unnest(tokens) t
        where position(t in lower(a.headline || ' ' || array_to_string(a.skills, ' '))) = 0)
    order by d.consented_at desc, d.handle
    limit p_limit offset p_offset;
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator tools. Run from the SQL editor as the project owner. These live in
-- the private schema, which PostgREST does not expose, and are revoked from
-- every client role below.
-- ---------------------------------------------------------------------------
create function fwp_private.admin_pending() returns table (
  kind text, email text, display_name text, summary text, link text, since timestamptz)
language sql stable security definer set search_path = pg_catalog as $$
  select 'recruiter'::text, u.email::text, m.display_name,
    'Firm: ' || p.firm_name || ' | Recruits for: ' || coalesce((
      select string_agg(c.company_name, '; ' order by c.company_name)
      from public.recruiter_clients c where c.user_id = p.user_id), '(nobody listed)'),
    p.proof_url, p.submitted_at
  from public.recruiter_profiles p
  join public.member_accounts m on m.user_id = p.user_id
  join auth.users u on u.id = p.user_id
  where p.status = 'pending'
  union all
  select 'candidate'::text, u.email::text, m.display_name,
    'Headline: ' || a.headline || ' | Skills: ' || array_to_string(a.skills, ', '),
    null::text, d.consented_at
  from public.candidate_discovery d
  join public.member_accounts m on m.user_id = d.user_id
  join public.account_profiles a on a.user_id = d.user_id
  join auth.users u on u.id = d.user_id
  where d.enabled and d.review_status = 'pending'
  order by 6;
$$;

create function fwp_private.admin_set_recruiter_status(p_email text, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid; cur text; has_proof boolean; has_clients boolean;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(p_email));
  if uid is null then raise exception 'No such user'; end if;
  select p.status, p.proof_url is not null into cur, has_proof
    from public.recruiter_profiles p where p.user_id = uid for update;
  if cur is null then raise exception 'No recruiter profile for that user'; end if;
  has_clients := exists (select 1 from public.recruiter_clients c where c.user_id = uid);
  if not (
    (cur = 'pending' and p_status in ('verified', 'rejected', 'suspended'))
    or (cur = 'verified' and p_status = 'suspended')
    or (cur in ('draft', 'rejected') and p_status = 'suspended')
    or (cur = 'suspended' and p_status = 'pending')
  ) then raise exception 'Not allowed: % -> %', cur, p_status; end if;
  if p_status = 'verified' and not (has_proof and has_clients) then
    raise exception 'A verified recruiter needs a link and a non-empty hires-for list';
  end if;
  update public.recruiter_profiles set status = p_status,
    verified_at = case when p_status = 'verified' then now() else null end,
    submitted_at = case when p_status = 'pending' then now() else submitted_at end,
    updated_at = now() where user_id = uid;
  insert into fwp_private.review_log(user_id, kind, from_status, to_status, note)
    values (uid, 'recruiter', cur, p_status, p_note);
  insert into fwp_private.privacy_audit(user_id, event) values (uid, case p_status
    when 'verified' then 'recruiter_verified' when 'rejected' then 'recruiter_rejected'
    when 'suspended' then 'recruiter_suspended' else 'recruiter_reopened' end);
end;
$$;

create function fwp_private.admin_set_candidate_review(p_email text, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare uid uuid; cur text;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(p_email));
  if uid is null then raise exception 'No such user'; end if;
  select d.review_status into cur from public.candidate_discovery d where d.user_id = uid for update;
  if cur is null then raise exception 'That candidate has not asked to be discoverable'; end if;
  if not (
    (cur = 'pending' and p_status in ('approved', 'rejected', 'suspended'))
    or (cur = 'approved' and p_status in ('rejected', 'suspended'))
    or (cur in ('rejected', 'suspended') and p_status = 'pending')
  ) then raise exception 'Not allowed: % -> %', cur, p_status; end if;
  update public.candidate_discovery set review_status = p_status,
    reviewed_at = now(), updated_at = now() where user_id = uid;
  insert into fwp_private.review_log(user_id, kind, from_status, to_status, note)
    values (uid, 'candidate', cur, p_status, p_note);
  insert into fwp_private.privacy_audit(user_id, event) values (uid, case p_status
    when 'approved' then 'candidate_approved' when 'rejected' then 'candidate_rejected'
    when 'suspended' then 'candidate_suspended' else 'candidate_reopened' end);
end;
$$;

-- Aliases are one level deep: an alias points at a canonical name that is not
-- itself an alias, and nothing may point at an alias.
create function fwp_private.admin_add_alias(p_alias text, p_canonical text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare a text := fwp_private.normalize_company(p_alias); c text := fwp_private.normalize_company(p_canonical);
begin
  if length(a) < 2 or length(c) < 2 or a = c then raise exception 'Invalid alias'; end if;
  if exists (select 1 from fwp_private.company_aliases where alias_key = c) then
    raise exception 'The canonical name is itself an alias; use its canonical name';
  end if;
  if exists (select 1 from fwp_private.company_aliases where canonical_key = a) then
    raise exception 'Other aliases already point at that name; re-point them first';
  end if;
  insert into fwp_private.company_aliases(alias_key, canonical_key) values (a, c)
    on conflict (alias_key) do update set canonical_key = excluded.canonical_key;
end;
$$;

create function fwp_private.admin_remove_alias(p_alias text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
begin
  delete from fwp_private.company_aliases where alias_key = fwp_private.normalize_company(p_alias);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Every helper and operator function is closed to all client roles;
-- only the account-owner RPCs below are callable by signed-in users.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'fwp_private' and p.proname = any (array[
      'canonical_company', 'canonical_keys_conflict', 'current_discovery_consent',
      'text_mentions_block', 'candidate_readiness', 'candidate_blockers',
      'recruiter_blocked_by', 'recruiter_editor', 'recruiter_actor',
      'hide_candidate_when_inactive', 'admin_pending', 'admin_set_recruiter_status',
      'admin_set_candidate_review', 'admin_add_alias', 'admin_remove_alias'])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end;
$$;

revoke all on function public.save_my_recruiter_firm(text, text) from public, anon, authenticated;
revoke all on function public.add_my_client(text) from public, anon, authenticated;
revoke all on function public.remove_my_client(uuid) from public, anon, authenticated;
revoke all on function public.submit_my_recruiter_profile() from public, anon, authenticated;
revoke all on function public.set_my_discovery(boolean, text) from public, anon, authenticated;
revoke all on function public.my_discovery_status() from public, anon, authenticated;
revoke all on function public.search_candidates(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.save_my_recruiter_firm(text, text) to authenticated;
grant execute on function public.add_my_client(text) to authenticated;
grant execute on function public.remove_my_client(uuid) to authenticated;
grant execute on function public.submit_my_recruiter_profile() to authenticated;
grant execute on function public.set_my_discovery(boolean, text) to authenticated;
grant execute on function public.my_discovery_status() to authenticated;
grant execute on function public.search_candidates(text, text, integer, integer) to authenticated;

comment on table public.recruiter_profiles is 'Recruiter firm and operator verification state. Owner read only; written by fixed RPCs and operator functions.';
comment on table public.recruiter_clients is 'Companies a recruiter hires for. Compared with every candidate block list at search time.';
comment on table public.candidate_discovery is 'Consent and operator review for candidate discoverability. The only source of truth; account_profiles.discovery_active is unused and stays false.';
comment on function public.search_candidates(text, text, integer, integer) is 'Anonymous search for verified recruiters. Returns handle, headline, skills and work preference only.';
commit;
