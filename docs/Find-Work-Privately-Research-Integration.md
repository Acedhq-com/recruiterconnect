# Find Work Privately: research integration status

This first stage adapts the supplied tracker workflow into a private Research screen, a server-only provider adapter, and a verified-candidate research endpoint. It does not publish the personal tracker, import resumes, perform a full research refresh, or enable paid searches on the live site.

## Provider verification

- **Verified connection:** A bounded operator test returned three LinkedIn listings through the documented REST search endpoint, using the saved header credential. No resume, account identity, application, or employer message was submitted.
- **Authentication distinction:** MCP discovery is keyless, while MCP execution documents Bearer authentication. REST execution uses `x-api-key`; the adapter therefore discovers engine/action schemas through MCP, then executes the verified, fixed REST jobs-search endpoint ([ReefAPI MCP documentation](https://reefapi.com/mcp), [LinkedIn jobs API documentation](https://reefapi.com/docs/linkedin-jobs)).
- **Schema drift:** The actual `search_engines` tool schema uses `query`, not the overview page's `keywords`. The implementation does not depend on that overview example; it checks the known engine and live action schema before execution.

## Implemented boundaries

- **Private research:** `POST /api/career/research/search` uses the existing verified-session, active-candidate, owner-consistency, same-origin JSON, and private/no-store response boundaries. No caller-selected account, company, engine, action, endpoint, credential, or resume fields are accepted.
- **Private interface:** The Research screen exposes role, location, posting window, workplace, seniority, employment, and bounded result-count controls. Guest and unconfigured states are disabled. A permitted search needs explicit provider-credit acknowledgement, displays provenance and unknowns, and clears transient results on identity/permission changes or navigation.
- **Separate enablement:** The server must have `REEFAPI_RESEARCH_ENABLED=1`, a server-only `REEFAPI_KEY`, and an exact UUID in `REEFAPI_RESEARCH_OWNER_IDS`. None of these settings is changed by this implementation. Merely saving a Computer credential does not configure Vercel.
- **Bounded provider use:** Only the LinkedIn jobs search action is executable, with at most 20 results, a shared discovery/execution deadline, no redirects, response-size limits, schema-validated enums, and no automatic retries. A per-instance one-minute cooldown prevents accidental duplicate beta searches; it is not a durable commercial quota.
- **No fabricated evidence:** Results retain source provenance and plain-text descriptions, exclude recruiter/contact data and HTML, and remain discovered/unverified. Salary objects or missing pay are not converted into verified annual minima. Match score remains null, and interview chance/urgency remain not checked.
- **Eligibility rules:** The generic policy preserves the supplied workflow's fully-remote distinction, employer-posted annual minimum, strict travel ceiling, explicit state exclusions, unknowns, and positive-closure requirement. Personal salary, geography, and accounting/audit track defaults are not installed globally.
- **Existing product:** Public employer feeds, guest tracking, factual material drafts, pilot intake, and the synthetic recruiter preview remain unchanged. Research results are not silently written into existing application snapshots.

## Still required before a release

- Review and approve the code and production release separately from the already-published routing fix.
- Securely configure the production runtime key and exact beta-account allowlist. Do not copy temporary Computer credential-proxy tokens into Vercel or put any key in a `VITE_` variable.
- Complete verified account email setup and an authorized real sign-in test without disabling email verification.
- Verify provider data-use and redistribution rights before selling access; technical availability is not proof of upstream licensing.
- Add a durable, cross-instance allowance before opening paid provider use to multiple customers.
- Implement full ATS verification, resume-specific scoring/checklists, urgency collection, hidden/archive views, and refresh/import workflow. The preserved rubric alone is not an implemented scoring agent.
- Add compatible storage for additional source types before offering to save LinkedIn research results as existing application records.

No production deployment, database change, source enablement, message, application, subscription, purchase, or billing change is included.

## Verification completed

- **Full local pipeline:** 332 Python tests, 641 TypeScript tests, and all 132 expected cross-language decisions pass. Type checks, the production client build, report freshness, no-skips assertions, and reference-engine coverage gates pass. Reference coverage is not certification of production recruiter authorization.
- **New regression coverage:** 136 additional TypeScript cases cover provider/schema boundaries, exact owner allowlists, disabled and missing configuration, null/foreign owners, role and account restrictions, literal text, unsupported filters, source failure, duplicate/unsafe records, credential echoes, overlapping eligibility scopes, and positive closure evidence.
- **Browser checks:** The private Research interface was checked at desktop, 375-pixel mobile, and a short desktop window. Required fields, explicit credit acknowledgement, pending/empty/error states, metadata outage recovery, posting links, selectable URLs, literal text, unknown salary, long unbroken text, and disabled guest/recruiter access passed.
- **Identity switching:** An isolated synthetic browser test held an account-A response, signed out, signed in as account B, then released the old response. No account-A result appeared for B; B's independent request carried B's identity. This is frontend mock evidence, not a real email-code login or a live Vercel provider test.
- **Existing product checks:** Public-source loading and failure recovery, existing filters, guest tracking and archive/restore, formula-safe CSV, three factual material types and text/Markdown downloads, draft editing/removal, recruiter-demo search/saved searches/shortlists, simulated introductions, privacy overrides, pricing dialogs, and mocked pilot-storage failure were exercised. No real pilot entry, message, or application was submitted.
- **Visible quality:** No new page exceptions or horizontal overflow were found. Long titles, company names, and descriptions wrap within their cards. The checked visible research labels had a minimum measured contrast of 8.63:1; disabled controls were excluded from the WCAG text sample.
- **Privacy checks:** The production client contains no provider-key configuration, credential handles, uploaded tracker instructions, or test API key. No personal resume/tracker import, database migration, sign-in enablement, billing activation, or external credential transfer occurred.
