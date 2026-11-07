-- Owner-authorized, rollback-only provider assertions. No emails or passwords.
begin;
insert into auth.users(id,aud,role,email,email_confirmed_at,is_anonymous,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values
 ('27bfbc77-52b8-4984-b5e5-09f6c79b0001','authenticated','authenticated','qa-career-a@example.com',now(),false,now(),now(),'{}','{"account_kind":"admin"}'),
 ('27bfbc77-52b8-4984-b5e5-09f6c79b0002','authenticated','authenticated','qa-career-b@example.com',now(),false,now(),now(),'{}','{}'),
 ('27bfbc77-52b8-4984-b5e5-09f6c79b0003','authenticated','authenticated','qa-career-recruiter@example.com',now(),false,now(),now(),'{}','{"account_kind":"candidate"}'),
 ('27bfbc77-52b8-4984-b5e5-09f6c79b0004','authenticated','authenticated','qa-career-unconfirmed@example.com',null,false,now(),now(),'{}','{"email_verified":true}');
insert into auth.sessions(id,user_id,created_at,updated_at,not_after) values
 ('a856c0e1-b2fe-4a77-8533-000000000001','27bfbc77-52b8-4984-b5e5-09f6c79b0001',now(),now(),now()+interval '1 hour'),
 ('a856c0e1-b2fe-4a77-8533-000000000002','27bfbc77-52b8-4984-b5e5-09f6c79b0002',now(),now(),now()+interval '1 hour'),
 ('a856c0e1-b2fe-4a77-8533-000000000003','27bfbc77-52b8-4984-b5e5-09f6c79b0003',now(),now(),now()+interval '1 hour'),
 ('a856c0e1-b2fe-4a77-8533-000000000004','27bfbc77-52b8-4984-b5e5-09f6c79b0004',now(),now(),now()+interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"27bfbc77-52b8-4984-b5e5-09f6c79b0001","role":"authenticated","session_id":"a856c0e1-b2fe-4a77-8533-000000000001"}',true);
select public.onboard_my_account('candidate','Synthetic Candidate A',true);
select public.save_my_career_background(
 '{"name":"Synthetic A","headline":"Analyst","email":"","location":"","summary":"Literal background","skills":["Excel"],"experience":["Employer | Analyst | 2020-2026: Checked evidence."],"education":[]}',0);
select public.save_my_career_workflow(
 '{"id":"ashby-qa-overlap","role":"Analyst","company":"Synthetic Employer","location":"Remote","url":"https://jobs.example.com/test","source":"ashby","checkedAt":"2026-11-07T00:00:00.000Z"}',
 'Saved',E'=1+1\n"literal"','',null,null,0);
select public.save_my_career_document(
 '5947d40d-bdda-49f5-b53b-000000000001','resume','Synthetic draft A',E'=1+1\n"literal"','','',null,0);
do $$ begin
  if (select count(*) from public.career_backgrounds)<>1 then raise exception 'Background owner read failed'; end if;
  if (select notes from public.career_workflows)<>E'=1+1\n"literal"' then raise exception 'Provider changed literal workflow text'; end if;
  if (select body from public.career_documents)<>E'=1+1\n"literal"' then raise exception 'Provider changed literal document text'; end if;
  begin
    perform public.save_my_career_background('{"user_id":"foreign"}',1);
    raise exception 'Caller-selected owner or incomplete background accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.save_my_career_document('5947d40d-bdda-49f5-b53b-000000000001','resume','Stale','overwrite','','',null,0);
    raise exception 'Stale document overwrote a newer draft';
  exception when serialization_failure then null; end;
  begin
    perform public.save_my_career_document('5947d40d-bdda-49f5-b53b-000000000002','resume','Huge',repeat('x',50001),'','',null,0);
    raise exception 'Oversized document accepted';
  exception when invalid_parameter_value then null; end;
  begin
    update public.career_workflows set user_id='27bfbc77-52b8-4984-b5e5-09f6c79b0002';
    raise exception 'Direct owner reassignment accepted';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims','{"sub":"27bfbc77-52b8-4984-b5e5-09f6c79b0002","role":"authenticated","session_id":"a856c0e1-b2fe-4a77-8533-000000000002"}',true);
select public.onboard_my_account('candidate','Synthetic Candidate B',true);
do $$ begin
  if (select count(*) from public.career_backgrounds)<>0 or (select count(*) from public.career_workflows)<>0
    or (select count(*) from public.career_documents)<>0 then raise exception 'Cross-owner career data leaked'; end if;
  begin
    perform public.remove_my_career_document('5947d40d-bdda-49f5-b53b-000000000001',1);
    raise exception 'Foreign document was removable';
  exception when serialization_failure then null; end;
end $$;
-- Overlapping job IDs and draft UUIDs are independent across owners.
select public.save_my_career_workflow(
 '{"id":"ashby-qa-overlap","role":"Analyst","company":"Synthetic Employer","location":"Remote","url":"https://jobs.example.com/test","source":"ashby","checkedAt":"2026-11-07T00:00:00.000Z"}',
 'Applied','Private B notes','Follow up','2026-11-06',null,0);
select public.save_my_career_document('5947d40d-bdda-49f5-b53b-000000000001','cover_letter','Synthetic B','Only B','','',null,0);
do $$ begin
  if (select count(*) from public.career_workflows)<>1 or (select notes from public.career_workflows)<>'Private B notes'
    then raise exception 'Overlapping job scope is not isolated'; end if;
  if (select body from public.career_documents)<>'Only B' then raise exception 'Overlapping document scope is not isolated'; end if;
  begin
    delete from public.career_documents;
    raise exception 'Direct document deletion accepted';
  exception when insufficient_privilege then null; end;
end $$;
select public.remove_my_career_document('5947d40d-bdda-49f5-b53b-000000000001',1);
select set_config('request.jwt.claims','{"sub":"27bfbc77-52b8-4984-b5e5-09f6c79b0001","role":"authenticated","session_id":"a856c0e1-b2fe-4a77-8533-000000000001"}',true);
do $$ begin
  if (select body from public.career_documents)<>E'=1+1\n"literal"' then raise exception 'Another owner deletion affected A'; end if;
  if (select notes from public.career_workflows)<>E'=1+1\n"literal"' then raise exception 'Another owner workflow affected A'; end if;
end $$;
select public.request_my_account_deletion();
do $$ begin
  if (select count(*) from public.career_documents)<>0 then raise exception 'Deletion-requested account retained workspace access'; end if;
  begin
    perform public.remove_my_career_document('5947d40d-bdda-49f5-b53b-000000000001',1);
    raise exception 'Deletion-requested account edited workspace';
  exception when insufficient_privilege then null; end;
end $$;
select public.cancel_my_account_deletion();
do $$ begin
  if (select count(*) from public.career_documents)<>1 then raise exception 'Deletion cancellation lost private data'; end if;
end $$;

select set_config('request.jwt.claims','{"sub":"27bfbc77-52b8-4984-b5e5-09f6c79b0003","role":"authenticated","session_id":"a856c0e1-b2fe-4a77-8533-000000000003","user_metadata":{"account_kind":"candidate"}}',true);
select public.onboard_my_account('recruiter','Synthetic Recruiter',true);
do $$ begin
  if (select count(*) from public.career_workflows)<>0 then raise exception 'Recruiter read private career notes'; end if;
  begin
    perform public.save_my_career_document('5947d40d-bdda-49f5-b53b-000000000001','resume','Recruiter','Not allowed','','',null,0);
    raise exception 'Recruiter metadata created candidate authority';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"sub":"27bfbc77-52b8-4984-b5e5-09f6c79b0004","role":"authenticated","session_id":"a856c0e1-b2fe-4a77-8533-000000000004","user_metadata":{"email_verified":true}}',true);
do $$ begin
  if (select count(*) from public.career_documents)<>0 then raise exception 'Unconfirmed user read private drafts'; end if;
  begin
    perform public.remove_my_career_document('5947d40d-bdda-49f5-b53b-000000000001',1);
    raise exception 'Unconfirmed email edited workspace';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"sub":"27bfbc77-52b8-4984-b5e5-09f6c79b0001","role":"authenticated","session_id":"a856c0e1-b2fe-4a77-8533-000000000002"}',true);
do $$ begin
  if (select count(*) from public.career_documents)<>0 then raise exception 'Wrong-user session leaked drafts'; end if;
end $$;
reset role;
update public.member_accounts set status='suspended' where user_id='27bfbc77-52b8-4984-b5e5-09f6c79b0001';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"27bfbc77-52b8-4984-b5e5-09f6c79b0001","role":"authenticated","session_id":"a856c0e1-b2fe-4a77-8533-000000000001"}',true);
do $$ begin
  if (select count(*) from public.career_documents)<>0 then raise exception 'Suspended account read private data'; end if;
  begin
    perform public.remove_my_career_document('5947d40d-bdda-49f5-b53b-000000000001',1);
    raise exception 'Suspended account edited drafts';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.member_accounts set status='active' where user_id='27bfbc77-52b8-4984-b5e5-09f6c79b0001';
delete from auth.sessions where id='a856c0e1-b2fe-4a77-8533-000000000001';
set local role authenticated;
do $$ begin
  if (select count(*) from public.career_documents)<>0 then raise exception 'Revoked session read a draft'; end if;
  begin
    perform public.remove_my_career_document('5947d40d-bdda-49f5-b53b-000000000001',1);
    raise exception 'Revoked session edited drafts';
  exception when insufficient_privilege then null; end;
end $$;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$ begin
  begin
    perform count(*) from public.career_documents;
    raise exception 'Anonymous access to private documents';
  exception when insufficient_privilege then null; end;
  begin
    perform public.remove_my_career_document('5947d40d-bdda-49f5-b53b-000000000001',1);
    raise exception 'Anonymous write RPC accepted';
  exception when insufficient_privilege then null; end;
  if not has_function_privilege('anon','public.register_pilot_interest(text,text,text,text,text,boolean)','execute')
    then raise exception 'Original pilot intake grant changed'; end if;
end $$;
rollback;
select 'Career workspace isolation, overlapping IDs, literal-text readback, active-session, role, version, deletion and anonymous-denial assertions passed; fixtures rolled back.' as status;
