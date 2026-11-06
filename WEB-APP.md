# RecruiterConnect web app

The app adds a functional, responsive recruiting-product preview to the existing Python/TypeScript security-contract repository. The original contract fixtures and reference evaluators remain intact.

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

## Product boundary

- **Discovery:** Twelve explicitly synthetic, anonymous profiles; role/skill keyword search; profession, location, work arrangement, employment type, minimum/maximum experience, maximum annualized USD budget, and availability; sorting and recoverable empty states.
- **Workspace:** Session-only shortlists, CSV export with formula-prefix neutralization, saved searches, profile details, and simulated introductions/withdrawal. No browser storage, real messages, real identities, or cross-session account promises.
- **Candidate controls:** A reference-engine simulation of company allows/blocks, current-employer exclusion, discovery pause, and selected-company/broader verified modes. This does not update a real candidate account or prove production RLS.
- **Pilot interest:** Real signup storage through a bounded Supabase RPC; explicit contact consent; no public lead reads or direct anonymous inserts; no email sent automatically.
- **Pricing:** Proposed free candidates, $49/month single-recruiter pilot, and $129/month three-seat pilot. No checkout, active subscription, or billing entitlements.

## Deployment

The root `vercel.json` builds `dist/public` with Vite and serves Express API routes from `api/index.ts`. `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are server runtime variables; no service-role key is used or needed.

Keep `ALLOW_PREVIEW_PROXY` unset on Vercel. It is only for the private Computer preview backend and allows the opaque preview origin; production form requests require the site's own origin.

The linked Vercel project is `recruiterconnect` in workspace `aced2`; no other project is modified. The initial CLI link reported that automatic GitHub integration did not connect, so do not assume a Git push redeploys this app until that integration is authorized. A direct CLI deployment remains supported.

## Database and operations

The new Supabase project is separate from other products. Its public schema contains only the private pilot-lead table and the bounded registration RPC; production recruiting identities and permissions are intentionally not stored here yet.

The migrations enable RLS and revoke public direct table access. The RPC validates fields and explicit consent, enforces matching audience/plan, normalizes and deduplicates email/audience pairs, and serializes global caps of 100 new records per hour and 1,500 total. Caps are deliberate pilot safeguards, not a complete anti-bot solution.

The Supabase advisor's “RLS enabled, no policy” informational finding is expected because direct table access is intentionally denied. The anonymous `SECURITY DEFINER` warning is also intentional for this narrow write-only intake RPC; it has an empty search path, fixed SQL, no arbitrary identifiers, no read response, strict input limits, and no general CRUD authority. Review it before expanding the schema ([Supabase advisor explanations](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)).

The owner can review and remove leads in the Supabase dashboard. Do not grant browser users SELECT to make an admin page easier; implement a separately authenticated owner-only admin surface if needed. No automatic retention/deletion schedule is claimed in this release.

## QA

The browser inventory is in `FLOWS.md`. Browser checks cover all main flows at 1440px and 375px, empty/conflicting filters, save/apply/delete searches, anonymous export, introduction withdrawal, scope precedence, current-employer exclusion, pause/resume, form validation, a real synthetic pilot signup, and a desktop/mobile/desktop resize cycle.

`scripts/check_pilot_live.ts` verifies the actual database's consent validation, idempotent registration, denied anonymous SELECT, and denied direct INSERT. It writes a synthetic record, so run it only against an authorized test/pilot project and then remove its exact reported synthetic email using the owner's connector after confirming the text round trip.
