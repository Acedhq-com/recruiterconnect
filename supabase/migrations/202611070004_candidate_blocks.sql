-- Candidate privacy controls, phase 1: a private current employer and a block
-- list. Nothing here makes anyone discoverable and no recruiter can read these
-- tables. Recruiter search does not exist yet; this stores the candidate's
-- protections so they are in place before it does.
begin;

-- Deterministic company key used to compare names. Lowercases, turns ASCII
-- punctuation and Unicode spaces into spaces, drops a leading "the" and trailing
-- legal suffixes ("Inc", "LLC", "LLP", "Ltd", "Corp", "Co", ...), and collapses
-- whitespace. Matching is deliberately generous: "Acme Co" and "Acme Inc" share
-- a key, which errs toward blocking more, not less. Affiliates and renamed
-- companies are not detected by this function.
create or replace function fwp_private.normalize_company(p_name text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare v text; prev text;
begin
  v := lower(coalesce(p_name, ''));
  v := replace(v, '&', ' and ');
  v := regexp_replace(v, '[\x01-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]+', ' ', 'g');
  v := btrim(regexp_replace(v, ' +', ' ', 'g'));
  v := regexp_replace(v, '^the ', '');
  loop
    prev := v;
    v := regexp_replace(v, ' (inc|incorporated|llc|llp|lp|ltd|limited|corp|corporation|co|company|plc|pllc|pc|gmbh|ag)$', '');
    exit when v = prev;
  end loop;
  return btrim(v);
end;
$$;

create table public.candidate_private (
  user_id uuid primary key references public.member_accounts(user_id) on delete cascade,
  current_employer text not null check (length(current_employer) between 2 and 150),
  current_employer_key text not null check (length(current_employer_key) between 2 and 150),
  updated_at timestamptz not null default now()
);

create table public.candidate_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.member_accounts(user_id) on delete cascade,
  company_name text not null check (length(company_name) between 2 and 150),
  company_key text not null check (length(company_key) between 2 and 150),
  source text not null check (source in ('current_employer', 'candidate')),
  created_at timestamptz not null default now(),
  unique (user_id, company_key)
);
create unique index candidate_blocks_one_current_employer
  on public.candidate_blocks (user_id) where source = 'current_employer';

alter table public.candidate_private enable row level security;
alter table public.candidate_blocks enable row level security;
revoke all on public.candidate_private, public.candidate_blocks from public, anon, authenticated;
grant select on public.candidate_private, public.candidate_blocks to authenticated;
create policy candidate_private_owner_read on public.candidate_private for select to authenticated
  using ((select auth.uid()) = user_id and (select fwp_private.session_is_active()));
create policy candidate_blocks_owner_read on public.candidate_blocks for select to authenticated
  using ((select auth.uid()) = user_id and (select fwp_private.session_is_active()));

-- Append-only by privilege: no role except the table owner can touch it, and
-- events carry no company names.
create table fwp_private.privacy_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  event text not null check (event in ('current_employer_set', 'block_added', 'block_removed')),
  created_at timestamptz not null default now()
);
revoke all on fwp_private.privacy_audit from public, anon, authenticated;

-- Same lock order as the other private writers: auth.users -> auth.sessions ->
-- member_accounts (UPDATE, which also serializes this user's block changes).
create or replace function fwp_private.privacy_actor() returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.verified_user_id();
begin
  perform 1 from public.member_accounts
    where user_id = actor and account_kind = 'candidate' and status = 'active' for update;
  if not found then
    raise exception 'An active candidate account is required' using errcode = '42501';
  end if;
  return actor;
end;
$$;

create or replace function public.save_my_current_employer(p_employer text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.privacy_actor(); clean text; new_key text;
begin
  if p_employer is null then raise exception 'Invalid employer' using errcode = '22023'; end if;
  clean := btrim(p_employer);
  new_key := fwp_private.normalize_company(clean);
  if length(clean) not between 2 and 150 or clean ~ '[[:cntrl:]]'
    or length(new_key) not between 2 and 150
  then raise exception 'Invalid employer' using errcode = '22023'; end if;
  -- A previous current employer stays blocked as an ordinary entry; the
  -- candidate decides whether to remove it. Protection is never dropped silently.
  update public.candidate_blocks set source = 'candidate'
    where user_id = actor and source = 'current_employer' and company_key <> new_key;
  insert into public.candidate_blocks(user_id, company_name, company_key, source)
    values (actor, clean, new_key, 'current_employer')
    on conflict (user_id, company_key)
    do update set source = 'current_employer', company_name = excluded.company_name;
  if (select count(*) from public.candidate_blocks where user_id = actor) > 50 then
    raise exception 'Block list is full' using errcode = '54000';
  end if;
  insert into public.candidate_private(user_id, current_employer, current_employer_key)
    values (actor, clean, new_key)
    on conflict (user_id) do update set current_employer = excluded.current_employer,
      current_employer_key = excluded.current_employer_key, updated_at = now();
  insert into fwp_private.privacy_audit(user_id, event) values (actor, 'current_employer_set');
end;
$$;

create or replace function public.add_my_block(p_company text) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.privacy_actor(); clean text; new_key text;
begin
  if p_company is null then raise exception 'Invalid company' using errcode = '22023'; end if;
  clean := btrim(p_company);
  new_key := fwp_private.normalize_company(clean);
  if length(clean) not between 2 and 150 or clean ~ '[[:cntrl:]]'
    or length(new_key) not between 2 and 150
  then raise exception 'Invalid company' using errcode = '22023'; end if;
  -- Re-adding something already blocked is a no-op, not an error.
  if exists (select 1 from public.candidate_blocks where user_id = actor and company_key = new_key) then
    return;
  end if;
  if (select count(*) from public.candidate_blocks where user_id = actor) >= 50 then
    raise exception 'Block list is full' using errcode = '54000';
  end if;
  insert into public.candidate_blocks(user_id, company_name, company_key, source)
    values (actor, clean, new_key, 'candidate');
  insert into fwp_private.privacy_audit(user_id, event) values (actor, 'block_added');
end;
$$;

create or replace function public.remove_my_block(p_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.privacy_actor(); block_source text;
begin
  if p_id is null then raise exception 'Invalid block' using errcode = '22023'; end if;
  select source into block_source from public.candidate_blocks
    where id = p_id and user_id = actor for update;
  if not found then return; end if;
  if block_source = 'current_employer' then
    raise exception 'Your current employer cannot be removed; change it instead' using errcode = '22023';
  end if;
  delete from public.candidate_blocks where id = p_id and user_id = actor;
  insert into fwp_private.privacy_audit(user_id, event) values (actor, 'block_removed');
end;
$$;

revoke all on function fwp_private.normalize_company(text) from public, anon, authenticated;
revoke all on function fwp_private.privacy_actor() from public, anon, authenticated;
revoke all on function public.save_my_current_employer(text) from public, anon, authenticated;
revoke all on function public.add_my_block(text) from public, anon, authenticated;
revoke all on function public.remove_my_block(uuid) from public, anon, authenticated;
grant execute on function public.save_my_current_employer(text) to authenticated;
grant execute on function public.add_my_block(text) to authenticated;
grant execute on function public.remove_my_block(uuid) to authenticated;

comment on table public.candidate_private is 'Owner-only private candidate fields. Never returned by any recruiter-facing function.';
comment on table public.candidate_blocks is 'Companies a candidate must never be shown to. The current employer is always present once set. Owner-only read; written by fixed RPCs.';
commit;
