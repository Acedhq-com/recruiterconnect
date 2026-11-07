# RecruiterConnect discovery rule test suite

## Find Work Privately career workspace

The primary app combines real employer job feeds, application tracking, a factual resume/cover-letter/interview-preparation studio, private-background editing, and gated owner-only account storage. The public adapter is reused from the same owner's `jobtracker` repository without importing personal tracker data or resumes. Guest work is explicitly tab-only; document generation runs locally from supplied facts, not an undisclosed paid AI service.

The earlier recruiter directory, shortlists, company-control simulation, and pilot intake remain available in a separate, clearly synthetic recruiter preview. Public sign-in and cloud saving stay disabled until verification email is configured and tested. Real recruiter access, payments, automatic applications, and automatic personal-data import are not enabled.

See `WEB-APP.md` for setup, deployment, and security boundaries, `FLOWS.md` for browser acceptance coverage, and `REVENUE-PLAN.md` for the proposed path to a paid pilot. `npm run dev` starts the web app; the existing cross-language contract tests are still part of the complete verification runner.

## Original contract suite

Runnable Python and TypeScript contract tests for candidate-controlled recruiter discovery. Both languages consume the same hand-authored fixtures and expected decisions. The supplied reference implementations make the suite executable without an application checkout; they are not the previous Supabase implementation and do not validate its SQL, row-level security, or HTTP endpoints.

This initializes the previously empty `storyshaw2-hue/recruiterconnect` repository. There is no production discovery service in this checkout yet, so the active CI check is explicitly a reference-harness check, not a production-authorization approval.

The initial local run passed 332 Python tests and 293 TypeScript tests, with exact parity across 132 shared scenarios. See `VALIDATION.md` for coverage metrics, runtime versions, and the validation boundary.

## Security contract

The contract follows the previously described recruiter-discovery design. The exact scope representation, validation behavior, time boundaries, and handling of secondary memberships below are explicit assumptions for this standalone suite. Review them against your production schema before making these tests a release gate.

- **Authentication and binding:** The authenticated account must be an active recruiter. The requested candidate and opportunity must match the trusted records. The opportunity must belong to the requesting recruiter's verified membership. An administrator or candidate role has no implicit bypass of the recruiter endpoint.
- **Company isolation:** An employer membership can recruit only for that same company. An agency needs an active, verified mandate for the named hiring employer. Switching company, recruiter, candidate, opportunity, or membership cannot reuse a different scope.
- **Permission precedence:** Authentication, context binding, membership/company verification, and agency verification are prerequisites. A paused candidate is invisible. Current employers and their reviewed affiliate closure are excluded. Applicable blocks override every allow, including a more specific allow. Selected-company mode then requires both the recruiting company and hiring company to have an applicable allow.
- **Secondary memberships:** Exclusions inspect every currently valid, verified membership of the requesting account, not just the opportunity's membership. A recruiter cannot switch memberships to conceal an association with a blocked employer. Selected-company allows are required only for the active recruiting company and hiring company.
- **Affiliate hierarchy:** Reviewed affiliate links are undirected for exclusion purposes and are followed transitively, with cycle detection. Pending/rejected relationships do not confer a verified affiliation. Affiliation never propagates an allow.
- **Scope hierarchy:** Every rule is bound to an exact candidate and company ID. An explicit scope is one of `company`, `recruiter`, `opportunity`, or `recruiter_opportunity`. Narrow scopes additionally require their exact non-null IDs. All applicable denies are combined before allows; scope specificity is not an override.
- **Null and empty values:** Missing/null scope objects, required IDs, rule collections, employer collections, membership collections, mandate collections, or affiliate collections fail closed. An empty allowlist denies selected-company discovery. Empty collections are valid where the absence of records is known. `expires_at_ms: null` explicitly means no expiry; `revoked_at_ms: null` means not revoked. A revocation in the future does not apply before its timestamp.
- **Time boundaries:** Validity intervals are start-inclusive and expiry-exclusive, using integer Unix milliseconds. Expiry exactly at `now_ms` denies access. Verification cannot start in the future. The clock is injected and fixed in tests.
- **Payload protection:** Successful discovery returns exactly the five anonymous fields in the fixture. Identity data, grants, current employers, internal reasons, and arbitrary source-record fields never belong in the anonymous summary. Internal decision reasons are test diagnostics, not a public API response.
- **Input provenance:** `auth`, account, companies, memberships, policies, rules, affiliations, and mandates must be loaded or resolved by trusted server code. The request accepts only `candidate_id` and `opportunity_id`. Client-supplied company, recruiter, role, verification, or scope claims are rejected. A unit test cannot prove that an adapter actually obtains these records securely.

## Layout

```text
shared/base.json                 Synthetic trusted context
shared/cases.json                Language-independent expected decisions
shared/presets.json              Agency and multi-membership test contexts
python/discovery_contract/       Reference evaluator, adapter loader, fixtures
python/tests/                    Contract, hierarchy, property, isolation tests
typescript/src/                 Matching reference evaluator and adapter loader
typescript/tests/               Matching contract and property tests
scripts/                        Output parity and CI artifact validation
.github/workflows/               Runnable reference CI and production template
requirements-ci.txt             Pinned Python test dependencies
package-lock.json               Pinned TypeScript test dependency graph
```

The test suite is synchronous by design. An async production evaluator needs an application-specific synchronous wrapper or an async adaptation of the test adapter. No live database, credentials, personal data, network access during tests, or deployment is required.

## Run locally

Use Python 3.12 or newer and a supported Node.js version listed in `package.json`.

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-ci.txt
npm ci

python -m scripts.run_ci
```

On Windows, activate with `.venv\Scripts\activate` instead. The runner executes linting, Python tests, strict TypeScript checking, TypeScript tests, exporters, parity checks, and report validation. Both test commands produce JUnit XML and coverage reports under `reports/`; property tests use reproducible settings and parameterized tests retain descriptive scenario IDs.

For individual commands, start report generation first, then run each tool:

```sh
python -m scripts.validate_ci_reports --start
python -m pytest
npm run typecheck
npm test
npm run export:contract
python -m scripts.check_parity
python -m scripts.validate_ci_reports
```

## Connect the real implementation

The default target is deliberately a reference evaluator. A green reference run demonstrates that the harness works, not that production access controls are correct.

1. Write a Python adapter callable with the signature `evaluate(context: dict) -> dict`.
2. Write a TypeScript adapter exporting `evaluate(context: unknown): Decision`.
3. Map the normalized fixture context to your real authorization service, and normalize its result to `{ allowed, reason, summary }`. Do not copy the reference logic into an adapter or mock the authorization result.
4. Point the suite at the adapters and enforce production mode:

```sh
export DISCOVERY_PY_TARGET=my_application.discovery_test_adapter:evaluate
export DISCOVERY_TS_TARGET=./my_application/discovery-test-adapter.ts
export DISCOVERY_REQUIRE_PRODUCTION=1

python -m scripts.run_ci
```

Targets are loaded by both tests and exporters. Missing targets, import failures, invalid exports, and an unset/reference target in enforced-production mode are hard errors, never skipped tests or silent reference fallback. TypeScript accepts a module exporting `evaluate`; Python accepts `module:callable`. The guard prevents an obvious reference target, not a dishonest wrapper that delegates back to the reference.

Coverage configuration measures the bundled reference files and enables strict gates only in reference mode. In production mode, the runner adds `--no-cov --cov-fail-under=0` to pytest and disables reference coverage in Vitest; the contract checks remain mandatory, but production coverage is delegated to the application's existing configuration. Add the actual production files to coverage measurement and enforce your own thresholds rather than accepting coverage of a test double.

## CI

`.github/workflows/discovery-reference.yml` is runnable as supplied and explicitly named as a reference-harness check. It runs Python tests, TypeScript tests, strict TypeScript checking, cross-language output parity, and report validation. The report validator rejects missing/empty reports, failures, errors, skips, duplicate case IDs, stale reports from a previous run, and mismatched contract outputs.

`.github/workflows/discovery-production.yml.example` is an intentionally inactive template. After implementing adapters, configure its target variables, copy it to a `.yml` filename, and make that production job a required branch-protection check. Its guard fails if either adapter target is absent; it does not silently skip an unwired production check.

The production job must also run your existing SQL/RLS and endpoint integration tests. In this project's earlier design, that includes the actual `discover_candidates` database function under candidate, recruiter, and anonymous roles, not a service-role connection.

## Coverage areas

- **Positive controls:** Explicitly selected employers, verified broad discovery, valid agencies, all scope kinds, unbounded validity, and irrelevant-rule noninterference.
- **Tenant isolation:** Wrong opportunity owners, swapped membership IDs, cross-company employers, same recruiter in multiple companies, cross-candidate rules, and repeated calls in alternating company contexts.
- **Permission hierarchy:** Broad deny versus narrow allow, narrow deny versus broad allow, overlapping scopes, current-employer exclusions, secondary affiliations, pause, role restrictions, and grants that cannot bypass discovery.
- **Null/malformed values:** Missing and null fields, empty collections, wildcard-like IDs, unknown enums, duplicate record IDs, unsafe numeric timestamps, malformed booleans, mismatched policy ownership, and unexpected caller claims.
- **State changes:** Pause/unpause, newly added blocks, revoked verification, changed employer, expired mandates, policy-version changes, and denial after an earlier successful call.
- **Robustness:** Input immutability, defensive copying of summaries, affiliate cycles, deterministic decisions, rule-order invariance, duplicate-rule idempotence, random scope overlap, and seeded tenant-isolation properties.
- **CI assertions:** Exact decision shape and types, exact anonymous projection, strict compiler settings, coverage thresholds for the reference implementation, JUnit validation, and exact cross-language result parity.

## Limits

These are unit and contract tests. They do not prove database RLS, SQL query filtering/counts/pagination, HTTP status or cache headers, transaction isolation during concurrent revocation, rate limits, notification privacy, authentication-token verification, or the correctness/completeness of company-affiliation data. Projection tests exclude extra fields but do not detect identifying prose in an otherwise permitted headline or skill. Add integration tests for those boundaries before release. A passing suite is not a production privacy guarantee.

All names, IDs, summaries, and contact information are synthetic. No real candidate records are included.
