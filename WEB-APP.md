# Find Work Privately web app

The app combines the public employer-feed adapter from the owner's job tracker with a candidate-controlled career workspace. The original Python/TypeScript discovery-contract fixtures and reference evaluators remain intact; the old synthetic recruiter preview is a separate area rather than the default home.

## Combined workspace

- **Find jobs:** The configured public Greenhouse, Ashby, and Lever employer boards, with check times, explicit source coverage, null-aware filters, and no fictional runtime fallback. These feeds are not a search of the whole web or a personalized resume match.
- **My applications:** Saved employer references, stages, literal notes, next actions, applied/follow-up dates, archive/restore, and CSV with spreadsheet-formula prefix protection. Tracked roles remain available when absent from a refreshed feed.
- **My background:** User-entered name, optional contact details, summary, skills, experience facts, and education. No personal tracker, private seed, or resume file is imported.
- **Application studio:** Local, fact-based resume, cover-letter, and interview-preparation drafts; editable output; text/Markdown downloads and copy. No credentials or accomplishments are invented, and no paid model request or employer submission is made.
- **Storage modes:** Guests use React memory only. Reloading or changing identity clears temporary work. Explicit cloud saving is available only to verified active candidate accounts after the account-email launch gate is completed.
- **Privacy:** The career workspace is never used as a recruiter directory. Recruiter self-selection, cached browser identities, foreign user IDs, and account deletion/suspension cannot grant candidate-workspace authority.

The existing dark, compact Calibri-first tracker direction is used for the career workspace, with bundled Carlito fallback fonts and their license. The recruiter preview retains its existing design and simulation disclosures.

Routes are `/#/` (jobs), `/#/pipeline`, `/#/background`, `/#/studio`, `/#/workspace-privacy`, and `/#/account`. The synthetic directory is at `/#/recruiters`; its demo state resets when leaving that preview.

## Run

```sh
npm ci
cp .env.example .env
# Fill the two server-side Supabase publishable configuration values.
npm run dev
```

The development server runs on port 5000 and watches backend changes. Without a configured database, the directory and privacy simulations still work; pilot signup explicitly reports unavailable rather than pretending to save anything.

```sh
npm run typecheck
npm run build
npm test
python -m scripts.run_ci
```

## Recruiter preview boundary

- **Discovery:** Twelve explicitly synthetic, anonymous profiles; role/skill keyword search; profession, location, work arrangement, employment type, minimum/maximum experience, maximum annualized USD budget, and availability; sorting and recoverable empty states.
- **Workspace:** Session-only shortlists, CSV export with formula-prefix neutralization, saved searches, profile details, and simulated introductions/withdrawal. No browser storage, real messages, real identities, or cross-session account promises.
- **Candidate controls:** A reference-engine simulation of company allows/blocks, current-employer exclusion, discovery pause, and selected-company/broader verified modes. This does not update a real candidate account or prove production RLS.
- **Pilot interest:** Real signup storage through a bounded Supabase RPC; explicit contact consent; no public lead reads or direct anonymous inserts; no email sent automatically.
- **Pricing:** Proposed free candidates, $49/month single-recruiter pilot, and $129/month three-seat pilot. No checkout, active subscription, or billing entitlements.

## Deployment

The root `vercel.json` builds `dist/public` with Vite and serves Express API routes from `api/index.ts`. `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are server runtime variables; no service-role key is used or needed. The 30-second function cap permits the adapter's bounded 12-second employer checks to finish. The public job response sets its own CDN cache header; all account, career, pilot, error, and unknown API responses remain non-cacheable.

The exact `/api/jobs` rewrite must precede the wildcard API rewrite. Vercel passes named rewrite captures through the query string, so the wildcard otherwise adds `path=jobs` and trips the intentional no-custom-query feed guard ([Vercel configuration documentation](https://vercel.com/docs/project-configuration/vercel-json)). Keep the guard intact; the two deployment-boundary regression cases assert exact-route precedence and continued rejection of caller-supplied `path`.

Keep `ALLOW_PREVIEW_PROXY` unset on Vercel. It is only for the private Computer preview backend and allows the opaque preview origin; production form requests require the site's own origin.

The linked Vercel project is `recruiterconnect` in workspace `aced2`; no other project is modified. Although the initial CLI link did not connect GitHub, the integration later produced feature previews and a production deployment after a remote merge. Treat Git pushes and merges as deployment-capable actions. Obtain release approval before another push/merge or direct production deployment; do not rely on the earlier disconnected state.

## Database and operations

The Supabase project is separate from other products. It contains private pilot leads, verified member accounts, non-discoverable private candidate profiles, and additive `career_backgrounds`, `career_workflows`, and `career_documents` tables. No prior rows or column types were changed by the career migration.

Career reads require the owner's active, verified candidate session under database RLS. Writes use fixed authenticated-only RPCs deriving the owner from `auth.uid()`, not a body/header owner claim. Stale browser identity headers are an additional consistency check, not authority. Optimistic versions prevent stale overwrites; pilot limits are 300 job workflows and 30 document drafts per account.

The forward-only audit-hardening migration is a separate release artifact, not
automatically applied by the app. It rechecks authority after career lock waits,
holds user/session/account row locks through private mutations, and tightens SQL
admission against shared validation fixtures. Refresh-only logout resolves and
revokes the provider session or honestly reports incomplete revocation; it always
clears browser cookies. Express and static responses explicitly deny framing.

Run `python -m scripts.run_database_tests` only against a new disposable local
`*_audit` database. The separate database-security CI job applies all migrations,
runs the existing SQL assertions and lifecycle/validation regressions, and verifies
fixture cleanup. This is synthetic-auth SQL evidence, not SMTP, signed-JWT or
hosted-provider validation; see `audit/README.md` before any hosted migration.

### Candidate privacy controls (phase 1 of recruiter connection)

Candidates can record a private current employer and a block list on the account page. This stores protections only. It does not make anyone discoverable and no recruiter-facing function exists yet.

- Tables: `candidate_private` (current employer) and `candidate_blocks` (up to 50 companies; the current employer is always one of them). Both have owner-only read policies and no direct client writes. Writes go through `save_my_current_employer`, `add_my_block` and `remove_my_block`, which require an active verified candidate session and take the same row locks as the other private writers.
- Matching key: `fwp_private.normalize_company` lowercases, removes punctuation, a leading "the" and trailing legal suffixes (Inc, LLC, LLP, Ltd, Corp, Co and similar). It errs toward blocking more. It does not detect affiliates, parents or renamed companies; those must be listed by the candidate or added as aliases in a later phase.
- Changing the current employer keeps the previous one blocked as an ordinary entry. The current employer cannot be removed while it is current.
- `fwp_private.privacy_audit` records event types only (employer set, block added, block removed), never company names, and has no grants to any app role.
- Deliberately not included: a discoverability opt-in. Consent to be visible should be given when recruiter search exists, not recorded in advance. The page tells candidates they will be asked again.
- Limits to state in product copy: this controls what this site shows; it cannot stop a recruiter finding someone elsewhere; matching is by name.

`AUTH_EMAIL_READY` must stay unset or `0` until the sending subdomain is verified, Supabase SMTP and numeric-code templates are configured, and an authorized real sign-in email is tested. Never disable email confirmation to make the UI appear finished. Account cookies remain first-party, Secure/HttpOnly in production; tokens are not returned in JSON or browser storage.

The owner-only SQL assertions in `supabase/tests/career_workspace.sql` run as authenticated/anonymous database roles with synthetic sessions inside a rollback-only transaction. They cover overlapping IDs across users, revocation, role boundaries, versions, literal text, deletion status, and anonymous denial. They do not prove SMTP delivery or a real browser Auth-provider round trip.

The pilot migration enables RLS and revokes public direct table access. Its intake RPC validates fields and explicit consent, enforces matching audience/plan, normalizes and deduplicates email/audience pairs, and serializes global caps of 100 new records per hour and 1,500 total. Caps are deliberate pilot safeguards, not a complete anti-bot solution.

The Supabase advisor's “RLS enabled, no policy” informational finding is expected because direct table access is intentionally denied. The anonymous `SECURITY DEFINER` warning is also intentional for this narrow write-only intake RPC; it has an empty search path, fixed SQL, no arbitrary identifiers, no read response, strict input limits, and no general CRUD authority. Review it before expanding the schema ([Supabase advisor explanations](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)).

The owner can review and remove leads in the Supabase dashboard. Do not grant browser users SELECT to make an admin page easier; implement a separately authenticated owner-only admin surface if needed. No automatic retention/deletion schedule is claimed in this release.

## QA

Career acceptance additionally covers real feed loading, all 13 filters, missing-source behavior without fabricated fallback, retained applications, factual drafts of all three kinds, browser downloads, zero guest private-write requests, reload clearing, mock account save/reload/sign-out/switching, transient Auth failure hiding, and desktop/mobile/short-window layout. Mock UI sign-in sends no mail; actual production email activation remains unverified and disabled.

The browser inventory is in `FLOWS.md`. Browser checks cover all main flows at 1440px and 375px, empty/conflicting filters, save/apply/delete searches, anonymous export, introduction withdrawal, scope precedence, current-employer exclusion, pause/resume, form validation, a real synthetic pilot signup, and a desktop/mobile/desktop resize cycle.

`scripts/check_pilot_live.ts` verifies the actual database's consent validation, idempotent registration, denied anonymous SELECT, and denied direct INSERT. It writes a synthetic record, so run it only against an authorized test/pilot project and then remove its exact reported synthetic email using the owner's connector after confirming the text round trip.
