# RecruiterConnect audit regression and hardening checks

The original audit targeted
`d4d3a2f1deaa2f936dba5a7b48c2c3f6116101cf`. Its companion patch contained
104 cases, nine of which intentionally failed at that baseline. This follow-up
includes the fixes and a larger regression corpus; all tests must now pass
without skips or expected failures.

The source changes do not activate hosted migrations, email, billing, recruiter
discovery, GitHub branch settings, or deployments.

## Environments

The locked development dependencies now include `happy-dom@21.0.4` and
`psycopg[binary]==3.3.8`. No production runtime dependency was added.

```sh
python -m venv .venv
. .venv/bin/activate
npm ci --ignore-scripts --audit=false
python -m pip install --require-hashes -r requirements-ci.txt
```

The audit ran on Python 3.12.15, Node.js 20.20.2, npm 10.8.2, and PostgreSQL
18.6. The repository's GitHub reference matrix also passed on Python 3.12 /
Node 22 and Python 3.14 / Node 24.

## Application and discovery verification

The application/reference runner includes the previously failing web assertions,
new DOM/feed coverage, the shared API-validation corpus, and discovery additions:

```sh
python -m scripts.run_ci
PYTHONPATH=python python audit/mutation_probe.py
```

The mutation probe still detects all ten hand-selected Python-reference policy
mutations with the original 132 shared scenarios. It is a mutation sample, not
a comprehensive mutation score.

## HTTP and browser-header regressions

```sh
./node_modules/.bin/vitest run \
  web-tests/audit-security-regressions.test.ts \
  --coverage.enabled=false
```

Expected now: all pass. RC-02 resolves a refresh-only session before provider
logout, always clears cookies, and reports incomplete revocation on failure.
RC-06 asserts explicit anti-framing headers in both Express and the deployment
manifest; it is hardening, not evidence of an observed framing exploit.

## Disposable PostgreSQL checks

Never run these against a hosted, production, shared, or valuable database.
The runner refuses nonlocal destinations before connecting and refuses a
nonempty application schema. It never drops or resets an existing database.
Use a disposable PostgreSQL cluster and a new database ending `_audit`.
The fixture creates synthetic `auth.users` / `auth.sessions` and creates the
cluster-wide `anon` / `authenticated` test roles only if absent.

The database owner must be able to create roles and switch roles. No
service-role key, real user password, or hosted connection is required.

```sh
createdb recruiterconnect_audit
AUDIT_DATABASE_URL='dbname=recruiterconnect_audit' \
  python -m scripts.run_database_tests
```

Expected: all migrations, both existing SQL scripts and all 117 database cases
pass. The runner verifies fresh, failure-free JUnit output and zero leftover
synthetic rows. After this initial setup, rerun tests only with:

```sh
AUDIT_DATABASE_URL='dbname=recruiterconnect_audit' \
  python -m pytest audit/test_database.py --no-cov -o addopts='' -q
```

RC-01 covers four career mutation types against deletion, suspension, revocation,
session expiry and bans while waiting for the career mutex. Reverse-order tests
also cover private profiles and onboarding: once authority is locked, lifecycle changes wait
for the writer to finish, then later writes are denied.

RC-03 runs the same 59 versioned fixtures against the real SQL RPCs and API
schemas, including internal/IP/port URLs, whitespace, email, controls, Unicode
code-point limits and calendar-valid UTC timestamps. SQL conservatively admits
ASCII public DNS URLs; the API retains its existing URL parser for compatible
reads rather than broadening SQL admission to every URL-parser edge case.

This fixture validates repository SQL, grants, RLS, and lock behavior under
synthetic claims. It does not reproduce hosted Supabase, JWT signature checks,
PostgREST, email OTP, SMTP, or deployment settings.

## Migration and release boundaries

`202611070002_audit_hardening.sql` is forward-only: it changes validation and
locking functions, not table/column types or existing rows. The authority lock
order is auth user, auth session, member account, private data; career writers
take their advisory mutex before authority locks. Checks after waits use wall
clock time, not the transaction's stale `now()`.

Hosted application is a separate release action. Before applying it, inspect
existing rows for the tightened background/snapshot validators and arrange an
explicit repair if necessary; this change never rewrites or deletes user data
automatically. SMTP/OTP, cryptographic JWT verification and actual hosted
PostgREST behavior still need authorized production-shaped validation.

`.github/workflows/database-security.yml` runs the database suite in PostgreSQL
18.6 on pushes and PRs. The reference workflow remains separately named.
Require both checks and independent review in GitHub before sensitive merges;
this source update does not change branch protection or required-check settings.

Global pilot quotas are still not a full per-client anti-bot control. Fleet-wide
feed refresh coordination and privacy-minimal throttling remain separate
operational work, not claims made by these fixes.

## Remaining production discovery tests

No production candidate-discovery endpoint or SQL function exists in this
repository. Do not fabricate passing integration tests for an absent boundary.
Before introducing real candidate records, implement production-target tests for
JWT-to-authority loading, every list/detail/export/count path, filter-before-
pagination/count semantics, cache isolation/invalidation, concurrent revoke/pause,
RLS against a real Supabase stack, and public denial-response non-enumerability.
The synchronous pure-policy adapters should not stand in for an async network
boundary suite.
