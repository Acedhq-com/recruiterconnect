# RecruiterConnect web app acceptance and QA inventory

This inventory covers the existing deployed app, now being connected to the owner-purchased FindWorkPrivately.com domain. The discovery-contract fixtures and the existing demo/pilot flows remain release-regression requirements.

## Ordered launch work

- First: real private accounts with verified email sign-in and owner-only profile storage. Public sign-in stays disabled until the sending domain, SMTP, and email-code template are configured and verified.
- Next: production discovery permissions, then recruiter verification, then billing, then automatic redeployment. Do not report those later items complete merely because private accounts exist.
- Existing Supabase pilot signups must be preserved. Do not move, rename, or alter the other ACED application.

## Verified checkpoint

- The existing production preview loads at https://findworkprivately.com/ with 12 synthetic profiles. The www address redirects to the apex. Production still has the RecruiterConnect title; the new branding and private-account interface have not been deployed.
- The private-account database migration is applied. Database assertions passed for owner isolation, verified and active sessions, revocation, safe account kinds, optimistic versions, and deletion-request boundaries. All database test fixtures were rolled back.
- The local full runner, `.venv/bin/python -m scripts.run_ci`, passes: 332 Python tests, 402 TypeScript tests, and 132 identical expected contract decisions. Type checking, the production build, report freshness, no-skips checks, and reference coverage gates also pass. Reference-engine coverage is not evidence that production discovery permissions are finished.
- Local browser checks passed at 1440 × 1000 and 375 × 812, including desktop/mobile resizing, disabled sign-in, and mocked code validation, onboarding, draft save/reload, skill limits, deletion request/cancellation, sign-out, and the unverified recruiter screen. The mock checks sent no emails and created no real accounts.
- Existing browser flows were rechecked: search, combined filters, sorting, saved-search apply/delete, shortlist add/remove and CSV download, simulated introduction/withdrawal, privacy pause and company block cycles, employer exclusion, pricing dialogs, consent validation, honest pilot-storage failure, and mobile navigation. No new page errors or horizontal overflow were observed.
- `AUTH_EMAIL_READY` remains unset or false. The next release gate is a verified sending subdomain, configured Supabase SMTP, numeric-code email templates, and an authorized real-code sign-in test. The connected email actions do not manage domains or SMTP settings, so dashboard access or an explicitly authorized secure credential setup is still required.
- No billing, paid upgrade, additional purchase, automatic redeployment, or real candidate discovery has been enabled. Preserve these gates when resuming.

## Account and domain acceptance

- FindWorkPrivately.com loads the existing app over HTTPS; the public title and wordmark say Find Work Privately. Legacy Vercel URLs remain usable.
- "Your account" opens first-party account sign-in on the canonical domain, not an embedded cross-site cookie flow.
- Account setup unavailable: sign-in is explicitly disabled, while the pilot-interest form and all existing demo features continue working.
- Account sign-in: email request, code entry, safe validation, same-origin checks, secure HttpOnly session cookies, refresh, and sign-out. No raw access or refresh tokens in JSON, URLs, logs, or browser storage.
- Verified users choose candidate or recruiter onboarding. Choosing recruiter is not verification and must grant no candidate access.
- A candidate can save and reload only their own private profile. Discovery remains off and is not directly writable by the client.
- Cross-account reads and writes fail at the database boundary, not just in the UI. Account-deletion requests are explicit, private, and accurately described as requests rather than immediate deletion.

## Requested outcome

- A shareable Vercel URL once the user's Vercel connection and project scope are authorized.
- A functional recruiter-discovery interface with additional job-related filters.
- A credible proposed monetization path that never sells candidate privacy.
- No claims of live candidates, verified organizations, real introductions, billing, or production authorization without the required backend.

## Main flows

- Discover: search role/skills; combine category, metro, work arrangement, employment, experience, budget, and availability filters; clear individually/all; sort; open a profile.
- Shortlist: add/remove from results and details; view shortlist; empty state; export anonymous shortlist CSV.
- Saved searches: name, save, apply, delete; session-only disclosure; no browser storage.
- Introductions: create a clearly simulated request with required company, role, salary, and message; see pending state; withdraw it; never reveal identity.
- Candidate privacy: company allow/block scopes, current-employer exclusions, pause/resume, simulation of different recruiting companies; identity is never released.
- Pricing: free candidate tier; proposed recruiter/team tiers; pilot dialog; validation; genuine success only if persistent backend accepts the lead; meaningful error otherwise.
- Trust: plain-language safety boundaries and FAQ; all navigation and mobile navigation.

## QA coverage

- Desktop 1440 × 1000 and mobile 375 × 812; no horizontal overflow, overlapping dialog controls, missing disclosure, or inaccessible navigation.
- Normal keyboard/click input for all primary flows; Escape dismisses dialogs; focus is restored; empty results are recoverable.
- Off-happy-path: conflicting filters; maximum/minimum experience; malformed pilot email; disconnected backend; duplicate introduction; removing the last saved item.
- State-cycle tests for shortlisting, filter changes, pause/resume, allow/block, saved searches, and withdrawal.
- Fresh deployed preview context plus the Vercel URL, if authorized; clean console and no credential/data leaks in bundles.
