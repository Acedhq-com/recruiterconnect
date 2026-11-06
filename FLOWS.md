# RecruiterConnect web app acceptance and QA inventory

This is a new web application in the existing test repository, not an edit to a previously deployed app. The test suites remain unchanged and are release-regression requirements.

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
