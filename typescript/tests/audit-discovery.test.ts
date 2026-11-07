import { expect, test } from "vitest";
import { loadTarget } from "../src/adapter.js";
import { context, materialize } from "../src/fixtures.js";
import type { JsonObject } from "../src/fixtures.js";
import { assertDecision, rule } from "./helpers.js";

// Audit extensions. These exercise the configured adapter, never a silent mock.
const evaluate = await loadTarget();
const offsets = [-1, 0, 1] as const;

function agency(): JsonObject {
  return materialize({
    id: "audit-agency", category: "agency", preset: "agency", expected: "ALLOWED",
  }) as JsonObject;
}

for (const field of ["valid_from_ms", "expires_at_ms", "revoked_at_ms"] as const) {
  test.each(offsets)(`audit: mandate ${field} boundary offset=%s`, offset => {
    const data = agency();
    data.mandates[0][field] = data.now_ms + offset;
    const allowed = field === "valid_from_ms" ? offset <= 0 : offset > 0;
    assertDecision(evaluate(data), allowed ? "ALLOWED" : "MANDATE_DENIED");
  });
  test.each(offsets)(`audit: secondary membership ${field} boundary offset=%s`, offset => {
    const data = context();
    const secondary = {
      ...structuredClone(data.memberships[0]), id: "audit-secondary", company_id: "employer-x",
    };
    secondary[field] = data.now_ms + offset;
    data.memberships.push(secondary);
    const live = field === "valid_from_ms" ? offset <= 0 : offset > 0;
    assertDecision(evaluate(data), live ? "EMPLOYER_BLOCKED" : "ALLOWED");
  });
}

test.each(["pending", "revoked", "suspended"])(
  "audit: secondary %s membership cannot create a live exclusion", status => {
    const data = context();
    data.memberships.push({
      ...structuredClone(data.memberships[0]), id: "audit-secondary", company_id: "employer-x", status,
    });
    assertDecision(evaluate(data), "ALLOWED");
  },
);

test("audit: a scoped secondary-company block applies without an allow for that company", () => {
  const data = context();
  data.memberships.push({
    ...structuredClone(data.memberships[0]), id: "audit-secondary", company_id: "company-b",
  });
  data.candidate.rules.push(rule("block", "recruiter_opportunity", "company-b"));
  assertDecision(evaluate(data), "BLOCKED");
});

test.each([NaN, Infinity, -Infinity])("audit: non-finite clock %s fails closed", now_ms => {
  assertDecision(evaluate(context({ now_ms })), "INVALID_CONTEXT");
});

test.each([64, 65])("audit: actor identifier length %s has an explicit boundary", length => {
  const data = context();
  const id = "a".repeat(length);
  data.auth.account_id = id; data.account.id = id; data.memberships[0].account_id = id;
  assertDecision(evaluate(data), length === 64 ? "ALLOWED" : "INVALID_CONTEXT");
});

test("audit: an unknown company in an otherwise irrelevant rule still fails closed", () => {
  const data = context();
  data.candidate.rules.push(rule("allow", "recruiter", "unresolved-company"));
  data.candidate.rules[1].scope.recruiter_id = "another-recruiter";
  assertDecision(evaluate(data), "INVALID_CONTEXT");
});

test("audit: affiliate exclusion is recomputed after a reviewed link is removed", () => {
  const data = context();
  data.affiliations = [{
    company_id: "company-a", related_company_id: "employer-x", review_status: "verified",
  }];
  assertDecision(evaluate(data), "EMPLOYER_BLOCKED");
  data.affiliations[0].review_status = "rejected";
  assertDecision(evaluate(data), "ALLOWED");
});

test("audit: repeated evaluation of a frozen trusted context is immutable", () => {
  const data = context();
  function freeze(value: unknown): void {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(data);
  const first = evaluate(data);
  const second = evaluate(data);
  assertDecision(first, "ALLOWED");
  expect(second).toEqual(first);
  expect(second.summary).not.toBe(first.summary);
  expect(second.summary?.skills).not.toBe(first.summary?.skills);
});
