import { describe, expect, test } from "vitest";
import { loadTarget } from "../src/adapter.js";
import { CASES, context, materialize } from "../src/fixtures.js";
import { assertDecision } from "./helpers.js";

const evaluate = await loadTarget();

describe("shared discovery contract", () => {
  test.each(CASES)("$id", (testCase) => {
    const data = materialize(testCase);
    const original = structuredClone(data);
    assertDecision(evaluate(data), testCase.expected, testCase.summary_patch);
    expect(data).toEqual(original);
  });
});

test("contract has positive controls, all categories, and unique scenario IDs", () => {
  expect(CASES.length).toBeGreaterThanOrEqual(100);
  expect(new Set(CASES.map((entry) => entry.id)).size).toBe(CASES.length);
  expect(CASES.filter((entry) => entry.expected === "ALLOWED").length).toBeGreaterThanOrEqual(15);
  const categories = new Set(CASES.map((entry) => entry.category));
  for (const category of [
    "allow", "auth", "agency", "scope", "hierarchy", "isolation", "null",
    "validation", "affiliation", "verification", "request", "time", "projection"
  ]) expect(categories.has(category)).toBe(true);
});

const required = [
  "/now_ms", "/account", "/account/id", "/account/role", "/account/status",
  "/candidate", "/candidate/id", "/candidate/policy", "/candidate/policy/candidate_id",
  "/candidate/policy/active", "/candidate/policy/mode", "/candidate/policy/version",
  "/candidate/current_employer_ids", "/candidate/rules", "/candidate/rules/0/candidate_id",
  "/candidate/rules/0/company_id", "/candidate/rules/0/effect", "/candidate/rules/0/scope",
  "/candidate/summary", "/candidate/summary/candidateId", "/candidate/summary/headline",
  "/candidate/summary/skills", "/candidate/summary/experienceBand", "/candidate/summary/workPreference",
  "/memberships", "/memberships/0/id", "/memberships/0/account_id", "/memberships/0/company_id",
  "/memberships/0/status", "/memberships/0/valid_from_ms",
  "/opportunity", "/opportunity/id", "/opportunity/membership_id",
  "/opportunity/hiring_company_id", "/opportunity/status",
  "/companies", "/companies/0/id", "/companies/0/kind", "/companies/0/verified",
  "/companies/0/active", "/mandates", "/affiliations"
];

describe.each(["null", "missing"] as const)("required-field %s checks", (operation) => {
  test.each(required)("%s fails closed", (pointer) => {
    const testCase = { id: "field-check", category: "validation", expected: "INVALID_CONTEXT",
      ...(operation === "null" ? { set: { [pointer]: null } } : { remove: [pointer] }) };
    assertDecision(evaluate(materialize(testCase)), "INVALID_CONTEXT");
  });
});

test.each(["companies", "memberships"])("duplicate %s authority IDs are ambiguous", (collection) => {
  const data = context();
  data[collection].push(structuredClone(data[collection][0]));
  assertDecision(evaluate(data), "INVALID_CONTEXT");
});

test.each(["scope", "account_id", "tenant_id", "isAdmin", "__proto__"])(
  "caller-supplied %s authority is rejected", (claim) => {
    assertDecision(evaluate(context({ request: { [claim]: { verified: true } } })), "INVALID_REQUEST");
  }
);

test.each(["*", "", " ", "company-*", "company-a/company-b", 12, true])(
  "invalid scope ID %j never grants", (value) => {
    const data = context();
    data.candidate.rules[0].company_id = value;
    assertDecision(evaluate(data), "INVALID_CONTEXT");
  }
);
