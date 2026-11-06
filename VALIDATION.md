# Discovery suite validation record

The web-app release extends the passing TypeScript count to 337 tests, including 44 new filter, export, validation, and API checks. The full runner passes 332 Python tests, strict application and harness TypeScript checks, the Vite production build, all 337 TypeScript tests, exact parity for 132 contract cases, and the existing coverage/report gates.

Browser validation covers desktop and 375px mobile main flows with no observed JavaScript page errors or horizontal mobile overflow. The pilot database additionally passed real write-only RPC, required-consent, duplicate-registration, denied public SELECT, and denied direct INSERT checks; these are pilot-intake checks, not production candidate-authorization validation.

The complete local verification runner passed against the bundled reference evaluators. These results validate the test harness and documented policy contract, not a production service, PostgreSQL function, HTTP endpoint, or row-level-security policy.

## Observed results

| Check | Result |
|---|---|
| Python unit, contract, property, and CI-validator tests | 332 passed; zero failures, errors, or skips |
| TypeScript unit, contract, property, and adapter tests | 293 passed; zero failures, errors, or skips |
| Shared hand-authored scenarios | 132 exact matching decisions in both languages |
| Python reference line and branch coverage | 100% |
| TypeScript reference line/function coverage | 100% / 100% |
| TypeScript reference statement/branch coverage | 98.98% / 98.60% |
| Reference coverage gates | At least 95% for the enforced metrics |
| Strict TypeScript compiler check | Passed |
| Python Ruff lint and formatting | Passed |
| Fresh JUnit/coverage/contract report validation | Passed |

Local runtime versions were Python 3.14.8 and Node.js 20.20.2. The active GitHub Actions matrix additionally checks Python 3.12 with Node.js 22 and Python 3.14 with Node.js 24.

## Reproduce

Install the locked dependencies as described in the README, then run the single verification entry point. It stops at the first failed command and rejects stale reports from an earlier invocation.

```sh
python -m scripts.run_ci
```

Each language includes 12 property tests with a maximum of 150 generated examples per property; small finite strategies can exhaust before reaching that maximum. Those generated examples are not added to the reported unit-test count.

## Production boundary

The repository was empty before this setup, so no production discovery code was available to exercise. Production mode is opt-in and rejects absent or obvious reference adapters instead of reporting a production pass.

Connect the actual implementation through `DISCOVERY_PY_TARGET` and `DISCOVERY_TS_TARGET`, enable `DISCOVERY_REQUIRE_PRODUCTION=1`, and activate the provided production workflow template. Production SQL/RLS, endpoint, caching, pagination/count filtering, and concurrent-revocation integration tests remain separate release requirements.
