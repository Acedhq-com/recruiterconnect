-- Run only with the project owner's authorized SQL connection.
-- All synthetic auth users, sessions, accounts and profile data are rolled back.
-- This does not send email, create passwords, test SMTP, or enable sign-in.
begin;

insert into auth.users (
  id, aud, role, email, email_confirmed_at, is_anonymous,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('95b757a9-a238-4747-a03e-1c070c638771', 'authenticated', 'authenticated',
   'qa-fwp-account-a@example.com', now(), false, now(), now(),
   '{"provider":"email"}', '{"email_verified":true,"account_kind":"admin","company_verified":true}'),
  ('95b757a9-a238-4747-a03e-1c070c638772', 'authenticated', 'authenticated',
   'qa-fwp-account-b@example.com', now(), false, now(), now(),
   '{"provider":"email"}', '{}'),
  ('95b757a9-a238-4747-a03e-1c070c638773', 'authenticated', 'authenticated',
   'qa-fwp-unconfirmed@example.com', null, false, now(), now(),
   '{"provider":"email"}', '{"email_verified":true}');
insert into auth.sessions (id, user_id, created_at, updated_at, not_after) values
  ('aa563cd9-45a6-4dca-a621-b9a09d9fa6a1', '95b757a9-a238-4747-a03e-1c070c638771', now(), now(), now() + interval '1 hour'),
  ('aa563cd9-45a6-4dca-a621-b9a09d9fa6b2', '95b757a9-a238-4747-a03e-1c070c638772', now(), now(), now() + interval '1 hour'),
  ('aa563cd9-45a6-4dca-a621-b9a09d9fa6c3', '95b757a9-a238-4747-a03e-1c070c638773', now(), now(), now() + interval '1 hour');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638771","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6a1","user_metadata":{"account_kind":"admin","company_verified":true}}', true);
do $$ begin
  if not public.account_session_active() then raise exception 'Verified session should be active'; end if;
  begin
    perform public.onboard_my_account('admin', 'Unsafe role', true);
    raise exception 'User metadata must not create an admin role';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.onboard_my_account('candidate', 'Private Candidate', false);
    raise exception 'Beta acknowledgment must be required in the database';
  exception when invalid_parameter_value then null; end;
end $$;
select public.onboard_my_account('candidate', 'Private Candidate', true);
select public.onboard_my_account('candidate', 'No overwrite', true);
do $$ begin
  if (select count(*) from public.member_accounts) <> 1 then raise exception 'Only the owner account may be read'; end if;
  if (select display_name from public.member_accounts) <> 'Private Candidate' then raise exception 'Onboarding must be idempotent'; end if;
  if (select count(*) from public.account_profiles) <> 1 then raise exception 'Candidate draft missing'; end if;
  if (select discovery_active from public.account_profiles) then raise exception 'Discovery must start off'; end if;
  begin
    perform public.onboard_my_account('recruiter', 'Role switch', true);
    raise exception 'Account type must not be silently switched';
  exception when invalid_parameter_value then null; end;
  begin
    update public.member_accounts set account_kind = 'recruiter';
    raise exception 'Direct account writes must be denied';
  exception when insufficient_privilege then null; end;
  begin
    update public.account_profiles set discovery_active = true;
    raise exception 'A client must not activate discovery directly';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.member_accounts(user_id,account_kind,display_name)
      values ('95b757a9-a238-4747-a03e-1c070c638772','candidate','Wrong owner');
    raise exception 'Direct cross-owner inserts must be denied';
  exception when insufficient_privilege then null; end;
end $$;
select public.save_my_private_profile('Private Candidate', '=1+1 "quoted"',
  array[' SQL ', 'US GAAP'], 'Remote', 1);
do $$ begin
  if (select version from public.account_profiles) <> 2 then raise exception 'Profile version must advance'; end if;
  if (select headline from public.account_profiles) <> '=1+1 "quoted"' then raise exception 'Profile text must be stored literally'; end if;
  if (select skills from public.account_profiles) <> array['SQL','US GAAP'] then raise exception 'Skills should be trimmed'; end if;
  begin
    perform public.save_my_private_profile('Private Candidate','Stale overwrite',array['SQL'],'Hybrid',1);
    raise exception 'Stale versions must not overwrite a private draft';
  exception when serialization_failure then null; end;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638772","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6b2"}', true);
select public.onboard_my_account('recruiter', 'Private Recruiter', true);
do $$ begin
  if (select count(*) from public.member_accounts) <> 1 then raise exception 'Another account must not bleed into reads'; end if;
  if (select count(*) from public.member_accounts where user_id='95b757a9-a238-4747-a03e-1c070c638771') <> 0 then raise exception 'Candidate account leaked to recruiter'; end if;
  if (select count(*) from public.account_profiles) <> 0 then raise exception 'Recruiter must not read candidate drafts'; end if;
  begin
    perform public.save_my_private_profile('Private Recruiter','Not a candidate',array['SQL'],'Remote',1);
    raise exception 'Recruiter self-selection must not create candidate authority';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638771","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6a1"}', true);
select public.request_my_account_deletion();
do $$ begin
  if (select status from public.member_accounts) <> 'deletion_requested' then raise exception 'Deletion request not recorded'; end if;
  if (select discovery_active from public.account_profiles) then raise exception 'Deletion request must keep discovery off'; end if;
  begin
    perform public.save_my_private_profile('Private Candidate','Blocked edit',array['SQL'],'Remote',2);
    raise exception 'Deletion-requested accounts must not edit';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638772","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6b2"}', true);
do $$ begin
  begin
    perform public.cancel_my_account_deletion();
    raise exception 'Another actor cannot cancel the candidate deletion request';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638771","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6a1"}', true);
select public.cancel_my_account_deletion();
do $$ begin
  if (select status from public.member_accounts) <> 'active' then raise exception 'Owner cancellation should restore active status'; end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638773","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6c3","email_confirmed_at":"2099-01-01","user_metadata":{"email_verified":true}}', true);
do $$ begin
  if public.account_session_active() then raise exception 'Metadata must not substitute for confirmed email'; end if;
  if (select count(*) from public.member_accounts) <> 0 then raise exception 'Unconfirmed identity must not read accounts'; end if;
  begin
    perform public.onboard_my_account('candidate','Unconfirmed',true);
    raise exception 'Unconfirmed email must not initialize an account';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638771","role":"authenticated"}', true);
do $$ begin
  if public.account_session_active() then raise exception 'A session ID is required'; end if;
  if (select count(*) from public.account_profiles) <> 0 then raise exception 'A JWT without a session must not read profiles'; end if;
end $$;
select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638771","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6b2"}', true);
do $$ begin
  if public.account_session_active() then raise exception 'A different user session must not be accepted'; end if;
end $$;

reset role;
update public.member_accounts set status='suspended' where user_id='95b757a9-a238-4747-a03e-1c070c638771';
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"95b757a9-a238-4747-a03e-1c070c638771","role":"authenticated","session_id":"aa563cd9-45a6-4dca-a621-b9a09d9fa6a1"}', true);
do $$ begin
  begin
    perform public.save_my_private_profile('Private Candidate','Suspended edit',array['SQL'],'Remote',2);
    raise exception 'Suspended accounts must not edit';
  exception when insufficient_privilege then null; end;
  begin
    perform public.cancel_my_account_deletion();
    raise exception 'Deletion cancellation must not bypass suspension';
  exception when insufficient_privilege then null; end;
  begin
    perform public.onboard_my_account('candidate','Suspension bypass',true);
    raise exception 'Re-onboarding must not bypass suspension';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.member_accounts set status='active' where user_id='95b757a9-a238-4747-a03e-1c070c638771';
update auth.sessions set not_after=now()-interval '1 minute' where id='aa563cd9-45a6-4dca-a621-b9a09d9fa6a1';
set local role authenticated;
do $$ begin
  if public.account_session_active() then raise exception 'Expired sessions must not remain active'; end if;
  if (select count(*) from public.account_profiles) <> 0 then raise exception 'Expired sessions must not read private drafts'; end if;
end $$;
reset role;
update auth.sessions set not_after=now()+interval '1 hour' where id='aa563cd9-45a6-4dca-a621-b9a09d9fa6a1';
update auth.users set banned_until=now()+interval '1 hour' where id='95b757a9-a238-4747-a03e-1c070c638771';
set local role authenticated;
do $$ begin
  if public.account_session_active() then raise exception 'Banned users must not retain account access'; end if;
end $$;
reset role;
update auth.users set banned_until=null where id='95b757a9-a238-4747-a03e-1c070c638771';
delete from auth.sessions where id='aa563cd9-45a6-4dca-a621-b9a09d9fa6a1';
set local role authenticated;
do $$ begin
  if public.account_session_active() then raise exception 'Deleted sessions must revoke access before JWT expiry'; end if;
  if (select count(*) from public.account_profiles) <> 0 then raise exception 'Revoked JWT session must not read private drafts'; end if;
  begin
    perform public.save_my_private_profile('Private Candidate','Revoked edit',array['SQL'],'Remote',2);
    raise exception 'Revoked sessions must not write';
  exception when insufficient_privilege then null; end;
end $$;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$ begin
  begin
    perform count(*) from public.member_accounts;
    raise exception 'Anonymous account reads must be denied';
  exception when insufficient_privilege then null; end;
  begin
    perform count(*) from public.account_profiles;
    raise exception 'Anonymous draft reads must be denied';
  exception when insufficient_privilege then null; end;
  begin
    perform public.onboard_my_account('candidate','Anonymous',true);
    raise exception 'Anonymous account creation RPC must be denied';
  exception when insufficient_privilege then null; end;
  begin
    perform public.account_session_active();
    raise exception 'Anonymous session introspection must be denied';
  exception when insufficient_privilege then null; end;
  if not has_function_privilege('anon','public.register_pilot_interest(text,text,text,text,text,boolean)','execute')
    then raise exception 'The existing pilot intake grant must remain intact'; end if;
end $$;

rollback;
select 'Private-account isolation, verified-session, revocation, safe-role, version and deletion assertions passed; all fixtures rolled back.' as status;
