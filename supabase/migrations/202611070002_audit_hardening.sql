-- Forward-only hardening. No tables/columns/rows are removed or rewritten.
-- Does not activate email, billing, deployment, or recruiter discovery.
begin;

-- Lock authority before a private mutation. All application writers acquire
-- auth.users -> auth.sessions -> member_accounts -> private data in that order.
-- Holding SHARE locks makes revocation/ban/deletion wait until the authorized
-- write commits; a revocation that committed first is rejected after the wait.
create or replace function fwp_private.verified_user_id() returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := auth.uid(); session_id text := auth.jwt()->>'session_id';
begin
  if actor is null or session_id is null then
    raise exception 'Verified sign-in required' using errcode = '42501';
  end if;
  perform 1 from auth.users where id = actor for share;
  if not found then
    raise exception 'Verified sign-in required' using errcode = '42501';
  end if;
  perform 1 from auth.sessions where user_id = actor and id::text = session_id for share;
  if not found then
    raise exception 'Verified sign-in required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.users u join auth.sessions s on s.user_id = u.id
    where u.id = actor and u.email_confirmed_at is not null
      and u.email is not null and not u.is_anonymous and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= clock_timestamp())
      and s.id::text = session_id
      and (s.not_after is null or s.not_after > clock_timestamp())
  ) then
    raise exception 'Verified sign-in required' using errcode = '42501';
  end if;
  return actor;
end;
$$;

create or replace function fwp_private.career_actor() returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not fwp_private.career_readable() then
    raise exception 'Active verified candidate session required' using errcode = '42501';
  end if;
  -- Do not retain authority row locks while waiting for the career mutex.
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':career', 0));
  actor := fwp_private.verified_user_id();
  perform 1 from public.member_accounts
    where user_id = actor and account_kind = 'candidate' and status = 'active'
    for share;
  if not found then
    raise exception 'Active verified candidate session required' using errcode = '42501';
  end if;
  return actor;
end;
$$;

create or replace function public.save_my_private_profile(
  p_display_name text, p_headline text, p_skills text[],
  p_work_preference text, p_expected_version bigint
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.verified_user_id();
begin
  -- This writer also updates member_accounts, so take UPDATE rather than
  -- upgrading a SHARE lock after touching account_profiles.
  perform 1 from public.member_accounts
    where user_id = actor and account_kind = 'candidate' and status = 'active'
    for update;
  if not found then
    raise exception 'An active candidate account is required' using errcode = '42501';
  end if;
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
  -- discovery_active remains deliberately untouched.
end;
$$;

create or replace function public.onboard_my_account(
  p_kind text, p_display_name text, p_beta_ack boolean
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := fwp_private.verified_user_id(); existing_kind text; existing_status text;
begin
  if p_beta_ack is distinct from true
    or p_kind is null or p_kind not in ('candidate', 'recruiter')
    or p_display_name is null or length(trim(p_display_name)) not between 2 and 80
    or p_display_name ~ '[[:cntrl:]]'
  then raise exception 'Invalid account details' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  insert into public.member_accounts(user_id, account_kind, display_name)
    values (actor, p_kind, trim(p_display_name)) on conflict (user_id) do nothing;
  -- Lock and inspect the actual winning row, including ON CONFLICT races.
  select account_kind, status into existing_kind, existing_status
    from public.member_accounts where user_id = actor for update;
  if existing_status is distinct from 'active' then
    raise exception 'Account is not active' using errcode = '42501';
  end if;
  if existing_kind is distinct from p_kind then
    raise exception 'Account type is already set' using errcode = '22023';
  end if;
  if p_kind = 'candidate' then
    insert into public.account_profiles(user_id) values (actor) on conflict (user_id) do nothing;
  end if;
end;
$$;

-- ECMAScript trim characters, including NBSP and BOM. PostgreSQL trim() alone
-- only removes U+0020 and can admit "empty" lines that Zod's trim() rejects.
create or replace function fwp_private.career_trim(value text) returns text
language sql immutable set search_path = pg_catalog as $$
  select btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;

create or replace function fwp_private.career_text(
  value text, maximum integer, multiline boolean default false
) returns boolean language plpgsql immutable set search_path = pg_catalog as $$
begin
  if value is null or maximum is null or maximum < 0 or char_length(value) > maximum then return false; end if;
  -- Match the existing API's line/prose control-character contract exactly.
  -- PostgreSQL text cannot contain U+0000 in the first place.
  if multiline then
    if value ~ U&'[\000B\000C\007F]' then return false; end if;
  elsif value ~ U&'[\0001-\001F\007F]' then return false;
  end if;
  -- The locked Zod 4.6.7 counts Unicode code points, as char_length does.
  -- The shared corpus guards that assumption when upgrading dependencies.
  return true;
end;
$$;

create or replace function fwp_private.career_lines(
  value jsonb, maximum_items integer, maximum_length integer
) returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare item jsonb; normalized text;
begin
  if value is null or jsonb_typeof(value) <> 'array'
    or jsonb_array_length(value) > maximum_items then return false; end if;
  for item in select entries.item from jsonb_array_elements(value) as entries(item) loop
    if jsonb_typeof(item) <> 'string' then return false; end if;
    normalized := fwp_private.career_trim(item #>> '{}');
    if length(normalized) < 1 or not fwp_private.career_text(normalized, maximum_length) then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function fwp_private.valid_career_background(value jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog as $background$
declare key text; email text;
begin
  if value is null or jsonb_typeof(value) <> 'object'
    or char_length(value::text) > 200000 then return false; end if;
  for key in select jsonb_object_keys(value) loop
    if not key = any(array['name','headline','email','location','summary','skills','experience','education']) then return false; end if;
  end loop;
  foreach key in array array['name','headline','email','location','summary'] loop
    if jsonb_typeof(value->key) is distinct from 'string' then return false; end if;
  end loop;
  -- Unlike line fields, the API's email and prose schemas do not trim.
  email := value->>'email';
  return fwp_private.career_text(fwp_private.career_trim(value->>'name'),100)
    and fwp_private.career_text(fwp_private.career_trim(value->>'headline'),160)
    and fwp_private.career_text(email,254)
    -- The locked Zod 4.6.7 email pattern. Shared fixtures check drift.
    and (email = '' or email ~ $email$^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$$email$)
    and fwp_private.career_text(fwp_private.career_trim(value->>'location'),160)
    and fwp_private.career_text(value->>'summary',3000,true)
    and fwp_private.career_lines(value->'skills',30,80)
    and fwp_private.career_lines(value->'experience',30,800)
    and fwp_private.career_lines(value->'education',12,300);
end;
$background$;

create or replace function fwp_private.career_public_posting_url(value text)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare authority text; hostname text;
begin
  if not fwp_private.career_text(value,4096) or value ~ '[[:space:]]'
    or strpos(value, chr(92)) > 0 then return false; end if;
  authority := (regexp_match(value, '^https://([^/?#]+)(?:[/?#].*)?$', 'i'))[1];
  if authority is null then return false; end if;
  hostname := lower(regexp_replace(authority, ':443$', ''));
  -- Conservative ASCII DNS admission: no credentials, IP literals, internal
  -- suffixes, non-default ports or URL-parser-dependent authority escapes.
  -- The API retains its existing URL parser for backwards-compatible reads.
  return char_length(hostname) <= 253
    and hostname ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    and hostname !~ '(^|\.)(localhost|local|internal)$';
end;
$$;

create or replace function fwp_private.career_utc_timestamp(value text)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare year integer; month integer; day integer; maximum_day integer;
begin
  if value is null or value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' then return false; end if;
  year := substring(value,1,4)::integer;
  month := substring(value,6,2)::integer;
  day := substring(value,9,2)::integer;
  if month not between 1 and 12 or substring(value,12,2)::integer > 23
    or substring(value,15,2)::integer > 59 or substring(value,18,2)::integer > 59 then return false; end if;
  maximum_day := (array[31,28,31,30,31,30,31,31,30,31,30,31])[month];
  if month = 2 and (year % 400 = 0 or (year % 4 = 0 and year % 100 <> 0)) then maximum_day := 29; end if;
  return day between 1 and maximum_day;
end;
$$;

create or replace function fwp_private.valid_career_snapshot(value jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare key text; normalized text;
begin
  if value is null or jsonb_typeof(value) <> 'object' then return false; end if;
  for key in select jsonb_object_keys(value) loop
    if not key = any(array['id','role','company','location','url','source','checkedAt']) then return false; end if;
  end loop;
  foreach key in array array['id','role','company','location','url','source','checkedAt'] loop
    if jsonb_typeof(value->key) is distinct from 'string' then return false; end if;
  end loop;
  foreach key in array array['id','role','company'] loop
    normalized := fwp_private.career_trim(value->>key);
    if length(normalized) = 0 then return false; end if;
  end loop;
  return fwp_private.career_text(fwp_private.career_trim(value->>'id'),300)
    and fwp_private.career_text(fwp_private.career_trim(value->>'role'),250)
    and fwp_private.career_text(fwp_private.career_trim(value->>'company'),160)
    and fwp_private.career_text(fwp_private.career_trim(value->>'location'),500)
    and fwp_private.career_public_posting_url(value->>'url')
    and (value->>'source') = any(array['greenhouse','ashby','lever'])
    and fwp_private.career_utc_timestamp(value->>'checkedAt');
end;
$$;

revoke all on function fwp_private.verified_user_id() from public,anon,authenticated;
revoke all on function fwp_private.career_actor() from public,anon,authenticated;
revoke all on function fwp_private.career_trim(text) from public,anon,authenticated;
revoke all on function fwp_private.career_text(text,integer,boolean) from public,anon,authenticated;
revoke all on function fwp_private.career_lines(jsonb,integer,integer) from public,anon,authenticated;
revoke all on function fwp_private.valid_career_background(jsonb) from public,anon,authenticated;
revoke all on function fwp_private.career_public_posting_url(text) from public,anon,authenticated;
revoke all on function fwp_private.career_utc_timestamp(text) from public,anon,authenticated;
revoke all on function fwp_private.valid_career_snapshot(jsonb) from public,anon,authenticated;
-- CREATE OR REPLACE preserves the existing authenticated-only public RPC grant.
commit;
