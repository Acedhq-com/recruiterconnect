-- Let candidates request LinkedIn research access through the same write-only
-- pilot intake. A 'research' plan is a candidate request, kept separate from the
-- candidate pilot signup so one person can appear on both lists.
alter table public.pilot_leads drop constraint pilot_leads_plan_check;
alter table public.pilot_leads add constraint pilot_leads_plan_check
  check (plan in ('candidate', 'founding', 'team', 'research'));

alter table public.pilot_leads drop constraint pilot_leads_email_audience_key;
alter table public.pilot_leads add constraint pilot_leads_email_audience_plan_key
  unique (email, audience, plan);

create or replace function public.register_pilot_interest(
  p_email text,
  p_name text,
  p_organization text,
  p_audience text,
  p_plan text,
  p_consent boolean
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_consent is distinct from true
    or p_email is null or length(trim(p_email)) not between 3 and 254
    or trim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_name is null or length(trim(p_name)) not between 2 and 100
    or p_organization is null or length(trim(p_organization)) not between 2 and 150
    or p_name ~ '[[:cntrl:]]' or p_organization ~ '[[:cntrl:]]'
    or p_audience is null or p_audience not in ('candidate', 'recruiter')
    or p_plan is null or p_plan not in ('candidate', 'founding', 'team', 'research')
    or (p_audience = 'candidate') is distinct from (p_plan in ('candidate', 'research'))
  then
    raise exception 'Invalid pilot request' using errcode = '22023';
  end if;

  -- Serialize the pilot-wide cap so concurrent requests cannot race the count.
  perform pg_catalog.pg_advisory_xact_lock(610624114);
  -- Duplicate requests give the same outcome without overwriting a previous signup.
  if exists (
    select 1 from public.pilot_leads
    where email = lower(trim(p_email)) and audience = p_audience and plan = p_plan
  ) then
    return true;
  end if;
  if (select count(*) from public.pilot_leads where created_at > now() - interval '1 hour') >= 100
    or (select count(*) from public.pilot_leads) >= 1500
  then
    raise exception 'Pilot intake temporarily full' using errcode = '54000';
  end if;
  insert into public.pilot_leads (email, name, organization, audience, plan)
  values (lower(trim(p_email)), trim(p_name), trim(p_organization), p_audience, p_plan)
  on conflict (email, audience, plan) do nothing;
  return true;
end;
$$;

-- create or replace keeps existing grants; restate the intended ones explicitly.
revoke all on function public.register_pilot_interest(text, text, text, text, text, boolean) from public, authenticated;
grant execute on function public.register_pilot_interest(text, text, text, text, text, boolean) to anon;
