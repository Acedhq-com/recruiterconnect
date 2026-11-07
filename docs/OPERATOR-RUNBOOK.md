# Operator runbook: recruiter and candidate review

Everything here runs in the Supabase SQL editor as the project owner. The functions live in the private `fwp_private` schema, which the web API does not expose, and no signed-in or anonymous role can execute them. Nothing in this file sends email; contact people yourself if you need to tell them a decision.

## See who is waiting

```sql
select * from fwp_private.admin_pending();
```

Each row is a recruiter application or a candidate who has opted in and is waiting for approval, oldest first. Recruiters show their firm, the companies they say they recruit for, and the link they gave. Candidates show the headline and skills exactly as recruiters would see them, plus their email so you can tell who they are.

## Recruiters

Before you verify anyone, check that:

- the link really shows this person at this firm;
- the hires-for list is complete. Candidates block companies by name, and a recruiter who leaves a client off sees candidates who blocked that client. Ask them directly if you are unsure;
- the person is the one who owns the email on the account.

```sql
-- Approve
select fwp_private.admin_set_recruiter_status('person@firm.com', 'verified', 'Checked LinkedIn; confirmed client list by email');
-- Decline (they can edit and apply again)
select fwp_private.admin_set_recruiter_status('person@firm.com', 'rejected', 'Link does not show the firm');
-- Pause immediately (stops search at once; they cannot edit)
select fwp_private.admin_set_recruiter_status('person@firm.com', 'suspended', 'Reason');
-- Let a paused recruiter back in for re-review, then verify again
select fwp_private.admin_set_recruiter_status('person@firm.com', 'pending');
```

Allowed moves: pending to verified, rejected or suspended; verified to suspended; draft or rejected to suspended; suspended to pending. Anything else is refused. Verifying needs a link and at least one hires-for company. The note is stored in `fwp_private.review_log`.

A verified recruiter who edits their firm, link or hires-for list drops back to `draft` automatically and cannot search until they resubmit and you verify again.

## Candidates

```sql
select fwp_private.admin_set_candidate_review('person@example.com', 'approved', 'Real person, headline is anonymous');
select fwp_private.admin_set_candidate_review('person@example.com', 'rejected', 'Headline names an employer');
select fwp_private.admin_set_candidate_review('person@example.com', 'suspended', 'Reason');
select fwp_private.admin_set_candidate_review('person@example.com', 'pending');   -- send back for review
```

Look at the headline and skills before approving. The system already refuses a headline or skills that name a company on the candidate's own block list, but it cannot spot a name, a unique job title, or a client that is not on the list.

Candidates are hidden at once, with no action from you, if they request deletion, are suspended, are banned, or turn discoverability off. They must consent again to come back.

## Company aliases

Matching is by normalized name plus a word-boundary prefix rule, so "Acme" already matches "Acme Holdings". Use aliases for names that do not share a prefix, such as an abbreviation or a rebrand:

```sql
select fwp_private.admin_add_alias('EY', 'Ernst & Young');   -- alias first, canonical name second
select fwp_private.admin_remove_alias('EY');
select * from fwp_private.company_aliases order by canonical_key, alias_key;
```

An alias applies immediately to every candidate's block list and every recruiter's list, in both directions. Aliases are one level deep: an alias cannot point at another alias.

## Checking what happened

```sql
select * from fwp_private.review_log order by id desc limit 50;          -- your decisions and notes
select user_id, event, created_at from fwp_private.privacy_audit order by id desc limit 100;   -- events only, never company names
select user_id, count(*) from fwp_private.search_log where created_at > now() - interval '1 day' group by 1;  -- search volume per recruiter
```

## Before real recruiters use it

- Candidates are visible to anyone you verify. Verify only people you have checked.
- There is no way to contact a candidate yet. Do not tell candidates or recruiters otherwise.
- Take legal advice on Illinois employment-agency licensing before charging recruiters.
