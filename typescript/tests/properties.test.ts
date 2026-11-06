import { expect, test } from "vitest";
import fc from "fast-check";
import { loadTarget } from "../src/adapter.js";
import { context } from "../src/fixtures.js";
import { assertDecision, KINDS, rule } from "./helpers.js";

const evaluate = await loadTarget();
const runs = { seed: 20261106, numRuns: 150 };
const kind = fc.constantFrom(...KINDS);
const slug = fc.stringMatching(/^[a-z]{1,12}$/);

test("property: every other tenant needs its own explicit allow", () => {
  fc.assert(fc.property(slug, (tenant) => {
    const companyId = `tenant-${tenant}`;
    const data = context();
    data.companies.push({ id: companyId, kind: "employer", verified: true, active: true });
    data.memberships[0].company_id = companyId;
    data.opportunity.hiring_company_id = companyId;
    assertDecision(evaluate(data), "NOT_SELECTED");
    data.candidate.rules.push(rule("allow", "company", companyId));
    assertDecision(evaluate(data), "ALLOWED");
  }), runs);
});

test("property: scope specificity never overrides a matching deny", () => {
  fc.assert(fc.property(kind, kind, fc.boolean(), (allowKind, blockKind, reverse) => {
    const rules = [rule("allow", allowKind), rule("block", blockKind)];
    if (reverse) rules.reverse();
    assertDecision(evaluate(context({ candidate: { rules } })), "BLOCKED");
  }), runs);
});

test("property: rule order and duplication are idempotent", () => {
  fc.assert(fc.property(fc.array(fc.tuple(kind, fc.constantFrom("allow", "block")), { maxLength: 20 }), (extra) => {
    const rules = [rule("allow"), ...extra.map(([scope, effect]) => rule(effect, scope))];
    const data = context({ candidate: { rules } });
    const expected = evaluate(structuredClone(data));
    data.candidate.rules = [...rules].reverse().concat(structuredClone(rules));
    expect(evaluate(data)).toEqual(expected);
  }), runs);
});

test("property: randomized membership expiry is exclusive", () => {
  fc.assert(fc.property(fc.integer({ min: -1000, max: 1000 }), (delay) => {
    const data = context();
    data.memberships[0].expires_at_ms = data.now_ms + delay;
    assertDecision(evaluate(data), delay > 0 ? "ALLOWED" : "MEMBERSHIP_DENIED");
  }), runs);
});

test("property: sensitive source fields are never projected", () => {
  fc.assert(fc.property(
    fc.constantFrom("fullName", "email", "resumeUrl", "currentEmployer", "phone"),
    fc.string({ minLength: 1, maxLength: 60 }), (key, secret) => {
      const data = context();
      data.candidate.summary[key] = secret;
      data.candidate.identity[key] = secret;
      assertDecision(evaluate(data), "ALLOWED");
    }
  ), runs);
});

test("property: transitive cyclic affiliate chains cannot hide employers", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 60 }), fc.boolean(), (length, cycle) => {
    const data = context();
    const nodes = Array.from({ length }, (_, index) => `node-${index}`);
    data.companies.push(...nodes.map((id) => ({ id, kind: "employer", verified: true, active: true })));
    const chain = ["company-a", ...nodes, "employer-x"];
    data.affiliations = chain.slice(0, -1).map((left, index) => ({
      company_id: left, related_company_id: chain[index + 1], review_status: "verified"
    }));
    if (cycle) data.affiliations.push({
      company_id: nodes.at(-1), related_company_id: "company-a", review_status: "verified"
    });
    assertDecision(evaluate(data), "EMPLOYER_BLOCKED");
  }), runs);
});

test("property: requests cannot self-assert tenant or verification authority", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    assertDecision(evaluate(context({ request: { company_id: value } })), "INVALID_REQUEST");
  }), runs);
});

test("property: truthy values are not Boolean authority", () => {
  fc.assert(fc.property(fc.constantFrom(null, 0, 1, "true", "false", [], {}), (value) => {
    assertDecision(evaluate(context({ candidate: { policy: { active: value } } })), "INVALID_CONTEXT");
  }), runs);
});

test("property: policy versions and identity grants cannot bypass blocks", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (version) => {
    assertDecision(evaluate(context({ candidate: {
      policy: { version }, rules: [rule("allow"), rule("block")],
      identity_grants: [{ approved: true, policy_version: version }]
    } })), "BLOCKED");
  }), runs);
});

test("property: recruiter-specific allows never transfer to new actors", () => {
  fc.assert(fc.property(slug, (actor) => {
    const data = context({ candidate: { rules: [rule("allow", "recruiter")] } });
    assertDecision(evaluate(data), "ALLOWED");
    const id = `actor-${actor}`;
    data.auth.account_id = id;
    data.account.id = id;
    data.memberships[0].account_id = id;
    assertDecision(evaluate(data), "NOT_SELECTED");
  }), runs);
});

test("property: affiliate order and duplicate edges do not change exclusions", () => {
  fc.assert(fc.property(fc.boolean(), fc.integer({ min: 1, max: 8 }), (reverse, duplicates) => {
    const data = context();
    const edges = [
      { company_id: "company-a", related_company_id: "affiliate-x", review_status: "verified" },
      { company_id: "affiliate-x", related_company_id: "employer-x", review_status: "verified" }
    ];
    data.affiliations = Array.from({ length: duplicates }, () => reverse ? [...edges].reverse() : edges).flat();
    assertDecision(evaluate(data), "EMPLOYER_BLOCKED");
  }), runs);
});

test("property: unrelated company blocks do not bleed across tenants", () => {
  fc.assert(fc.property(kind, (scope) => {
    const data = context();
    data.candidate.rules.push(rule("block", scope, "company-b"));
    assertDecision(evaluate(data), "ALLOWED");
  }), runs);
});
