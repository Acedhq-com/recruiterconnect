# RecruiterConnect: from working preview to first revenue

The current release is a public product preview with private, durable pilot-interest capture. Candidate profiles, shortlists, searches, company controls, and introduction requests are demonstrations; there is no live hiring network or active billing.

## Commercial hypothesis

- **Customer:** A small recruiter or recruiting team that values qualified, consensual conversations more than a large scraped directory.
- **Starting wedge:** Consider accounting and finance first, where your professional background can help you interview candidates and assess recruiter quality. This is a recommendation, not a validated market decision.
- **Free side:** Candidates should not have to pay to block an employer, pause their search, select companies, or control identity release.
- **Paid side:** Test $49 per recruiter per month and $129 per three-seat team per month after verified candidate supply and safe onboarding exist. These are proposed validation prices, not competitor benchmarks or active subscriptions.
- **Value proposition:** Job-related search, transparent named-company opportunities, private candidate intent, and mutually approved introductions. Do not charge for breaking privacy boundaries or exposing identities.

## First customer validation

Before adding more features, seek five recruiter interviews and twenty candidate interviews in one role family. The targets are planning goals, not current traction or an expected conversion forecast.

Ask recruiters about recent hard-to-fill roles, their actual budgets, why current sourcing fails, and whether they would pay the proposed price after seeing useful candidates. Ask candidates which companies they need excluded, what an acceptable opportunity looks like, and what evidence would make them trust an introduction request.

Use the live site's pilot form to record explicit contact interest. Review leads privately in the new RecruiterConnect Supabase project; never publish the lead table or use signups as public social proof without consent.

## Gate before charging

- **Real accounts and verification:** Implement real candidate/recruiter authentication, company membership checks, named agency-client mandates, and a manual verification process.
- **Durable permissions:** Store candidate rules server-side. Enforce tenant isolation, reviewed affiliate exclusions, paused discovery, revocation, and identity approvals at the database/API boundary.
- **Integration evidence:** The existing cross-language reference suite is not proof of production access controls. Connect actual production adapters and run SQL/RLS, endpoint, caching, pagination/count, and concurrent-revocation tests.
- **Supply and fulfillment:** Onboard real consenting candidates in the chosen niche, then run a small, hands-on introduction pilot. Do not sell access to an empty or synthetic directory.
- **Legal and operations:** Establish the legal operator, privacy/terms notices, retention and deletion process, support route, abuse reporting, and verification procedures. Review applicable recruiting and employment requirements with qualified advice.
- **Billing:** Add a payment provider only after pricing and fulfillment are validated. Require explicit subscription terms, cancellation/refund rules, and verified webhook-based entitlement updates. No payment provider is connected in this release.
- **Abuse controls:** The pilot RPC has validation, deduplication, no public reads, and pilot-wide caps. Add bot protection and stronger durable client-level limiting before actively advertising the form.

## Suggested first month

| Period | Intended work | Decision |
|---|---|---|
| First week | Use this URL for targeted interviews; recruit a small opted-in candidate group | Is the privacy problem frequent and painful in this niche? |
| Second week | Verify a few recruiters and manually test named-company opportunities | Can both sides reach useful, consensual conversations? |
| Third week | Finish production authentication, permissions, deletion, and integration tests | Is the service safe enough for real confidential job-search information? |
| Fourth week, only after the gates pass | Offer a small paid founding pilot at a clearly disclosed monthly rate | Will customers pay and renew for the actual service? |

No revenue or launch-date guarantee is implied. If conversations do not validate demand, change the niche or offer before spending time on additional filters or automation.

## What to measure

Track opted-in leads by audience, verified active candidates, verified recruiters, eligible discovery-to-introduction requests, candidate approval rate, completed useful conversations, paying seats, and renewal. Start with a measured baseline rather than displaying invented activity or conversion statistics.

Keep operational dashboards private and use aggregate public reporting only with a clear disclosure policy. The current site does not install third-party advertising pixels or claim live adoption metrics.
