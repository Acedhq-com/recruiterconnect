-- Additive career storage only. Existing pilot/account tables and rows are unchanged.
-- Account email activation, recruiter discovery, billing and personal-data import
-- are NOT enabled by this migration.
begin;

create or replace function fwp_private.career_text(value text, maximum integer, multiline boolean default false)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select value is not null and char_length(value) <= maximum
    and not (case when multiline then regexp_replace(value, E'[\n\r\t]', '', 'g') else value end ~ '[[:cntrl:]]');
$$;
create or replace function fwp_private.career_lines(value jsonb, maximum_items integer, maximum_length integer)
returns boolean language plpgsql immutable set search_path = pg_catalog, fwp_private as $$
declare item jsonb;
begin
  if value is null or jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > maximum_items then return false; end if;
  for item in select entries.item from jsonb_array_elements(value) as entries(item) loop
    if jsonb_typeof(item) <> 'string' or char_length(item #>> '{}') < 1
      or not fwp_private.career_text(item #>> '{}', maximum_length) then return false; end if;
  end loop;
  return true;
end;
$$;
create or replace function fwp_private.valid_career_background(value jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog, fwp_private as $$
declare key text;
begin
  if value is null or jsonb_typeof(value) <> 'object' or char_length(value::text) > 50000 then return false; end if;
  for key in select jsonb_object_keys(value) loop
    if not key = any(array['name','headline','email','location','summary','skills','experience','education']) then return false; end if;
  end loop;
  foreach key in array array['name','headline','email','location','summary'] loop
    if jsonb_typeof(value->key) is distinct from 'string' then return false; end if;
  end loop;
  return fwp_private.career_text(value->>'name',100)
    and fwp_private.career_text(value->>'headline',160)
    and fwp_private.career_text(value->>'email',254)
    and ((value->>'email') = '' or (value->>'email') ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    and fwp_private.career_text(value->>'location',160)
    and fwp_private.career_text(value->>'summary',3000,true)
    and fwp_private.career_lines(value->'skills',30,80)
    and fwp_private.career_lines(value->'experience',30,800)
    and fwp_private.career_lines(value->'education',12,300);
end;
$$;
create or replace function fwp_private.valid_career_snapshot(value jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog, fwp_private as $$
declare key text;
begin
  if value is null or jsonb_typeof(value) <> 'object' then return false; end if;
  for key in select jsonb_object_keys(value) loop
    if not key = any(array['id','role','company','location','url','source','checkedAt']) then return false; end if;
  end loop;
  foreach key in array array['id','role','company','location','url','source','checkedAt'] loop
    if jsonb_typeof(value->key) is distinct from 'string' then return false; end if;
  end loop;
  return fwp_private.career_text(value->>'id',300) and length(value->>'id') > 0
    and fwp_private.career_text(value->>'role',250) and length(value->>'role') > 0
    and fwp_private.career_text(value->>'company',160) and length(value->>'company') > 0
    and fwp_private.career_text(value->>'location',500)
    and fwp_private.career_text(value->>'url',4096)
    and (value->>'url') ~ '^https://[^/@[:space:]]+\.[^/@[:space:]]+(/|$)'
    and (value->>'source') = any(array['greenhouse','ashby','lever'])
    and (value->>'checkedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$';
end;
$$;
create or replace function fwp_private.career_readable()
returns boolean language sql stable security definer set search_path = pg_catalog, public, fwp_private as $$
  select fwp_private.session_is_active() and exists (
    select 1 from public.member_accounts where user_id = auth.uid()
      and account_kind = 'candidate' and status = 'active'
  );
$$;
create or replace function fwp_private.career_actor()
returns uuid language plpgsql security definer set search_path = pg_catalog, public, fwp_private as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not fwp_private.career_readable() then
    raise exception 'Active verified candidate session required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':career',0));
  return actor;
end;
$$;

create table public.career_backgrounds (
  user_id uuid primary key references public.member_accounts(user_id) on delete cascade,
  content jsonb not null check (fwp_private.valid_career_background(content)),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  updated_at timestamptz not null default now()
);
create table public.career_workflows (
  user_id uuid not null references public.member_accounts(user_id) on delete cascade,
  job_key text not null,
  snapshot jsonb not null check (fwp_private.valid_career_snapshot(snapshot)),
  stage text not null check (stage in ('Saved','Applied','Interviewing','Offer','Rejected','Archived')),
  notes text not null default '' check (fwp_private.career_text(notes,10000,true)),
  next_action text not null default '' check (fwp_private.career_text(next_action,500)),
  applied_date date,
  follow_up_date date,
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key(user_id,job_key),
  check (job_key = snapshot->>'id')
);
create table public.career_documents (
  user_id uuid not null references public.member_accounts(user_id) on delete cascade,
  id uuid not null,
  kind text not null check (kind in ('resume','cover_letter','interview_prep')),
  title text not null check (fwp_private.career_text(title,200) and length(title)>0),
  body text not null check (fwp_private.career_text(body,50000,true) and length(body)>0),
  target_role text not null default '' check (fwp_private.career_text(target_role,250)),
  target_company text not null default '' check (fwp_private.career_text(target_company,160)),
  source_job_id text check (source_job_id is null or (fwp_private.career_text(source_job_id,300) and length(source_job_id)>0)),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key(user_id,id)
);
create index career_workflows_owner_updated on public.career_workflows(user_id,updated_at desc);
create index career_documents_owner_updated on public.career_documents(user_id,updated_at desc);
alter table public.career_backgrounds enable row level security;
alter table public.career_workflows enable row level security;
alter table public.career_documents enable row level security;
revoke all on public.career_backgrounds,public.career_workflows,public.career_documents from public,anon,authenticated;
grant select on public.career_backgrounds,public.career_workflows,public.career_documents to authenticated;
create policy career_background_owner_read on public.career_backgrounds for select to authenticated
  using (user_id=auth.uid() and fwp_private.career_readable());
create policy career_workflow_owner_read on public.career_workflows for select to authenticated
  using (user_id=auth.uid() and fwp_private.career_readable());
create policy career_document_owner_read on public.career_documents for select to authenticated
  using (user_id=auth.uid() and fwp_private.career_readable());

create or replace function public.save_my_career_background(p_content jsonb,p_expected_version bigint)
returns void language plpgsql security definer set search_path = pg_catalog,public,fwp_private as $$
declare actor uuid := fwp_private.career_actor(); previous bigint;
begin
  if p_expected_version is null or p_expected_version < 0 or not fwp_private.valid_career_background(p_content)
    then raise exception 'Invalid background' using errcode='22023'; end if;
  select version into previous from public.career_backgrounds where user_id=actor;
  if coalesce(previous,0) <> p_expected_version then raise exception 'Stale background' using errcode='40001'; end if;
  insert into public.career_backgrounds(user_id,content,version) values(actor,p_content,1)
    on conflict(user_id) do update set content=excluded.content,
      version=career_backgrounds.version+1,updated_at=now();
end;
$$;
create or replace function public.save_my_career_workflow(
  p_snapshot jsonb,p_stage text,p_notes text,p_next_action text,
  p_applied_date date,p_follow_up_date date,p_expected_version bigint
)
returns void language plpgsql security definer set search_path = pg_catalog,public,fwp_private as $$
declare actor uuid := fwp_private.career_actor(); previous bigint; key text := p_snapshot->>'id';
begin
  if p_expected_version is null or p_expected_version < 0 or not fwp_private.valid_career_snapshot(p_snapshot)
    or p_stage is null or p_stage not in ('Saved','Applied','Interviewing','Offer','Rejected','Archived')
    or not fwp_private.career_text(p_notes,10000,true) or not fwp_private.career_text(p_next_action,500)
    then raise exception 'Invalid workflow' using errcode='22023'; end if;
  select version into previous from public.career_workflows where user_id=actor and job_key=key;
  if coalesce(previous,0) <> p_expected_version then raise exception 'Stale workflow' using errcode='40001'; end if;
  if previous is null and (select count(*) from public.career_workflows where user_id=actor)>=300
    then raise exception 'Pilot workflow capacity reached' using errcode='54000'; end if;
  insert into public.career_workflows(user_id,job_key,snapshot,stage,notes,next_action,applied_date,follow_up_date,version)
    values(actor,key,p_snapshot,p_stage,p_notes,p_next_action,p_applied_date,p_follow_up_date,1)
    on conflict(user_id,job_key) do update set snapshot=excluded.snapshot,stage=excluded.stage,notes=excluded.notes,
      next_action=excluded.next_action,applied_date=excluded.applied_date,follow_up_date=excluded.follow_up_date,
      version=career_workflows.version+1,updated_at=now();
end;
$$;
create or replace function public.save_my_career_document(
  p_id uuid,p_kind text,p_title text,p_body text,p_target_role text,p_target_company text,p_source_job_id text,p_expected_version bigint
)
returns void language plpgsql security definer set search_path = pg_catalog,public,fwp_private as $$
declare actor uuid := fwp_private.career_actor(); previous bigint;
begin
  if p_id is null or p_expected_version is null or p_expected_version<0
    or p_kind is null or p_kind not in ('resume','cover_letter','interview_prep')
    or not fwp_private.career_text(p_title,200) or length(p_title)=0
    or not fwp_private.career_text(p_body,50000,true) or length(p_body)=0
    or not fwp_private.career_text(p_target_role,250) or not fwp_private.career_text(p_target_company,160)
    or (p_source_job_id is not null and (not fwp_private.career_text(p_source_job_id,300) or length(p_source_job_id)=0))
    then raise exception 'Invalid document' using errcode='22023'; end if;
  select version into previous from public.career_documents where user_id=actor and id=p_id;
  if coalesce(previous,0)<>p_expected_version then raise exception 'Stale document' using errcode='40001'; end if;
  if previous is null and (select count(*) from public.career_documents where user_id=actor)>=30
    then raise exception 'Pilot document capacity reached' using errcode='54000'; end if;
  insert into public.career_documents(user_id,id,kind,title,body,target_role,target_company,source_job_id,version)
    values(actor,p_id,p_kind,p_title,p_body,p_target_role,p_target_company,p_source_job_id,1)
    on conflict(user_id,id) do update set kind=excluded.kind,title=excluded.title,body=excluded.body,
      target_role=excluded.target_role,target_company=excluded.target_company,source_job_id=excluded.source_job_id,
      version=career_documents.version+1,updated_at=now();
end;
$$;
create or replace function public.remove_my_career_document(p_id uuid,p_expected_version bigint)
returns void language plpgsql security definer set search_path = pg_catalog,public,fwp_private as $$
declare actor uuid := fwp_private.career_actor(); previous bigint;
begin
  select version into previous from public.career_documents where user_id=actor and id=p_id;
  if previous is null or p_expected_version is null or previous<>p_expected_version
    then raise exception 'Missing or stale document' using errcode='40001'; end if;
  delete from public.career_documents where user_id=actor and id=p_id and version=p_expected_version;
end;
$$;

revoke all on function fwp_private.career_text(text,integer,boolean) from public,anon,authenticated;
revoke all on function fwp_private.career_lines(jsonb,integer,integer) from public,anon,authenticated;
revoke all on function fwp_private.valid_career_background(jsonb) from public,anon,authenticated;
revoke all on function fwp_private.valid_career_snapshot(jsonb) from public,anon,authenticated;
revoke all on function fwp_private.career_actor() from public,anon,authenticated;
revoke all on function fwp_private.career_readable() from public,anon,authenticated;
grant execute on function fwp_private.career_readable() to authenticated;
revoke all on function public.save_my_career_background(jsonb,bigint) from public,anon,authenticated;
revoke all on function public.save_my_career_workflow(jsonb,text,text,text,date,date,bigint) from public,anon,authenticated;
revoke all on function public.save_my_career_document(uuid,text,text,text,text,text,text,bigint) from public,anon,authenticated;
revoke all on function public.remove_my_career_document(uuid,bigint) from public,anon,authenticated;
grant execute on function public.save_my_career_background(jsonb,bigint) to authenticated;
grant execute on function public.save_my_career_workflow(jsonb,text,text,text,date,date,bigint) to authenticated;
grant execute on function public.save_my_career_document(uuid,text,text,text,text,text,text,bigint) to authenticated;
grant execute on function public.remove_my_career_document(uuid,bigint) to authenticated;
comment on table public.career_backgrounds is 'Owner-only factual background; no recruiter access or automatic resume import.';
comment on table public.career_workflows is 'Owner-only application notes and saved employer references, protected by active candidate sessions and optimistic versions.';
comment on table public.career_documents is 'Owner-only application drafts. No employer messages or model calls are made by saving.';
commit;
