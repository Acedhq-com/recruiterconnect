import { expect, test } from "vitest";
import { loadTarget } from "../src/adapter.js";
import { BASE, context, materialize } from "../src/fixtures.js";
import type { JsonObject } from "../src/fixtures.js";
import { assertDecision, KINDS, rule } from "./helpers.js";

const evaluate = await loadTarget();

test("alternating companies never share a cached authorization", () => {
  const a = context();
  const b = context();
  b.memberships[0].company_id = "company-b";
  b.opportunity.hiring_company_id = "company-b";
  const allowedB = structuredClone(b);
  allowedB.candidate.rules = [rule("allow", "company", "company-b")];
  const blockedA = context({ candidate: { rules: [rule("allow"), rule("block")] } });
  const sequence: Array<[JsonObject, string]> = [
    [a, "ALLOWED"], [b, "NOT_SELECTED"], [blockedA, "BLOCKED"],
    [allowedB, "ALLOWED"], [a, "ALLOWED"], [b, "NOT_SELECTED"]
  ];
  for (const [data, reason] of sequence) assertDecision(evaluate(data), reason);
});

test("cross-candidate rules cannot reuse the first candidate's result", () => {
  assertDecision(evaluate(context()), "ALLOWED");
  const data = context();
  data.candidate.id = "candidate-2";
  data.request.candidate_id = "candidate-2";
  data.candidate.policy.candidate_id = "candidate-2";
  data.candidate.summary.candidateId = "candidate-2";
  assertDecision(evaluate(data), "CONTEXT_MISMATCH");
});

for (const allowKind of KINDS) {
  for (const blockKind of KINDS) {
    test.each([false, true])(`deny ${blockKind} dominates allow ${allowKind}; reversed=%s`, (reverse) => {
      const rules = [rule("allow", allowKind), rule("block", blockKind)];
      if (reverse) rules.reverse();
      assertDecision(evaluate(context({ candidate: { rules } })), "BLOCKED");
    });
  }
}

test.each(["agency-a", "company-a"])("agency/client block on %s dominates both allows", (company) => {
  const data = materialize({ id: "agency", category: "agency", preset: "agency", expected: "ALLOWED" }) as JsonObject;
  data.candidate.rules.push(rule("block", "company", company));
  assertDecision(evaluate(data), "BLOCKED");
});

test("permission changes apply to the next evaluation without stale allows", () => {
  const data = context();
  assertDecision(evaluate(data), "ALLOWED");
  data.candidate.policy.active = false;
  assertDecision(evaluate(data), "PAUSED");
  data.candidate.policy.active = true;
  data.candidate.policy.version++;
  assertDecision(evaluate(data), "ALLOWED");
  data.candidate.rules.push(rule("block"));
  assertDecision(evaluate(data), "BLOCKED");
  data.candidate.rules.pop();
  data.memberships[0].status = "revoked";
  assertDecision(evaluate(data), "MEMBERSHIP_DENIED");
  data.memberships[0].status = "verified";
  data.candidate.current_employer_ids = ["company-a"];
  assertDecision(evaluate(data), "EMPLOYER_BLOCKED");
});

test("changing an agency client cannot reuse an old mandate", () => {
  const data = materialize({ id: "agency", category: "agency", preset: "agency", expected: "ALLOWED" }) as JsonObject;
  assertDecision(evaluate(data), "ALLOWED");
  data.opportunity.hiring_company_id = "company-b";
  data.candidate.rules.push(rule("allow", "company", "company-b"));
  assertDecision(evaluate(data), "MANDATE_DENIED");
});

test("returned skills cannot mutate inputs or later responses", () => {
  const data = context();
  const first = evaluate(data);
  assertDecision(first, "ALLOWED");
  first.summary!.skills.push("UNAUTHORIZED-MUTATION");
  expect(data).toEqual(BASE);
  assertDecision(evaluate(data), "ALLOWED");
});

for (const recordKind of ["membership", "mandate"]) {
  test.each([-1, 0, 1])(`${recordKind} expiry boundary offset=%s`, (offset) => {
    const data = recordKind === "mandate"
      ? materialize({ id: "agency", category: "agency", preset: "agency", expected: "ALLOWED" }) as JsonObject
      : context();
    data[recordKind === "mandate" ? "mandates" : "memberships"][0].expires_at_ms = data.now_ms + offset;
    const reason = offset > 0 ? "ALLOWED" : recordKind === "mandate" ? "MANDATE_DENIED" : "MEMBERSHIP_DENIED";
    assertDecision(evaluate(data), reason);
  });
}
