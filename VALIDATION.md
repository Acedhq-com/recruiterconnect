# Discovery and private-workspace validation record

The audit-hardening follow-up passes the complete local application/reference
runner and a separate disposable-PostgreSQL security runner. No failures, errors,
skips, expected failures, stale reports, or weakened reference gates are used.

Reference coverage remains evidence about the bundled discovery evaluators,
not a real candidate-discovery endpoint. Database results exercise the actual
repository SQL, grants, RLS, locking and RPC validation under synthetic claims;
they do not validate hosted Supabase Auth, signed JWTs, SMTP or a deployed service.

## Observed results

| Check | Result |
|---|---|
| Python unit, contract, property, safety-guard and CI-validator tests | 375 passed; zero failures, errors, or skips |
| TypeScript application, DOM, contract, property and adapter tests | 632 passed; zero failures, errors, or skips |
| Local PostgreSQL security regressions | 117 passed; both existing SQL scripts passed; zero residual fixture rows |
| Versioned API/SQL storage-admission corpus | 59 identical valid/invalid fixtures exercised by both layers |
| Shared hand-authored scenarios | 132 exact matching decisions in both languages |
| Python reference line and branch coverage | 100% |
| TypeScript reference line/function coverage | 100% / 100% |
| TypeScript reference statement/branch coverage | 98.98% / 98.60% |
| Reference coverage gates | At least 95% for the enforced metrics |
| Strict TypeScript compiler check | Passed |
| Python Ruff lint and formatting | Passed |
| Fresh JUnit/coverage/contract report validation | Passed |
| npm audit and pip-audit | No known dependency advisories reported for the updated locks |
| Browser route matrix | 11 routes at 1440 × 1000 and 375 × 812; no page errors or horizontal overflow |
| Guest boundary | No POST requests or browser-storage writes; reload cleared temporary facts |

Local runtime versions were Python 3.12.15, Node.js 20.20.2 and PostgreSQL 18.6.
The reference GitHub Actions matrix checks Python 3.12 / Node 22 and Python
3.14 / Node 24. The new database workflow provisions PostgreSQL 18.6 separately;
it must remain distinct from production discovery approval.

## Regression outcomes

- **RC-01:** Twenty waiting-writer cases cover four career mutations against
  deletion, suspension, session revocation, expiry and bans. Eighteen reverse-order
  cases include private profiles/onboarding and prove authority changes wait for an already
  authorized writer, then later writes fail.
- **RC-02:** Refresh-only logout resolves and revokes a provider session or
  reports incomplete revocation. Browser cookies clear even on provider errors;
  no rotated cookies or tokens appear in the response.
- **RC-03:** Direct RPC admission rejects the original poisoning inputs and the
  shared corpus covers whitespace, email, Unicode code points, controls and
  calendar-valid UTC timestamps. Historical malformed rows still fail closed.
- **RC-04 / RC-06:** A dedicated local database workflow and explicit anti-framing
  headers are present. GitHub required-check settings are not changed by this code.

Browser smoke checks covered guest search/filter recovery, job details, saved
workflows and notes, all three factual draft types, local TXT/Markdown/CSV
downloads, draft removal/cancellation, synthetic recruiter shortlist/search/
introduction/withdrawal/privacy controls, pilot consent and disabled account
state. A deterministic public-feed fixture was intercepted only inside the
browser test context; the application has no new runtime fallback. No email,
pilot signup, real introduction or hosted private write was submitted.

## Reproduce

Install the locked dependencies as described in the README, then run the single verification entry point. It stops at the first failed command and rejects stale reports from an earlier invocation.

```sh
python -m scripts.run_ci
```

For SQL, create an empty disposable local database first. The runner refuses
remote destinations and nonempty application schemas without resetting them:

```sh
createdb recruiterconnect_audit
AUDIT_DATABASE_URL='dbname=recruiterconnect_audit' python -m scripts.run_database_tests
```

See `audit/README.md` for safety requirements, migration scope and test-only
reruns. The default Python testpaths intentionally do not connect to a database.

Each language includes 12 property tests with a maximum of 150 generated examples per property; small finite strategies can exhaust before reaching that maximum. Those generated examples are not added to the reported unit-test count.

## Production boundary

No production discovery endpoint or SQL function exists in this checkout.
Production mode is opt-in and rejects absent or obvious reference adapters
instead of reporting a production pass.

Connect the actual implementation through `DISCOVERY_PY_TARGET` and `DISCOVERY_TS_TARGET`, enable `DISCOVERY_REQUIRE_PRODUCTION=1`, and activate the provided production workflow template. Production SQL/RLS, endpoint, caching, pagination/count filtering, and concurrent-revocation integration tests remain separate release requirements.

The forward migration is not applied to hosted data by the app or these checks.
Review existing rows against the tighter validators before an authorized release;
no rows, tables or columns are automatically removed or rewritten. Authentication
email activation, billing, production discovery, per-client throttling, fleet-wide
feed coordination, branch protection and production deployment remain separate
operational/release actions.
