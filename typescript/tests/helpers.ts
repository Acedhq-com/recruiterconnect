import { expect } from "vitest";
import { EXPECTED_SUMMARY, merge } from "../src/fixtures.js";
import type { JsonObject } from "../src/fixtures.js";

export const KINDS = ["company", "recruiter", "opportunity", "recruiter_opportunity"] as const;
export type ScopeKind = typeof KINDS[number];

export function rule(effect: string, kind: ScopeKind = "company", companyId = "company-a"): JsonObject {
  const scope: JsonObject = { kind };
  if (kind === "recruiter" || kind === "recruiter_opportunity") scope.recruiter_id = "recruiter-a";
  if (kind === "opportunity" || kind === "recruiter_opportunity") scope.opportunity_id = "opportunity-a";
  return { candidate_id: "candidate-1", company_id: companyId, effect, scope };
}
export function assertDecision(actual: unknown, reason: string, summaryPatch: JsonObject = {}): void {
  expect(actual).not.toBeNull();
  expect(typeof actual).toBe("object");
  expect(Array.isArray(actual)).toBe(false);
  const result = actual as JsonObject;
  expect(Object.keys(result).sort()).toEqual(["allowed", "reason", "summary"]);
  expect(typeof result.allowed).toBe("boolean");
  expect(typeof result.reason).toBe("string");
  expect(result.reason).toBe(reason);
  expect(result.allowed).toBe(reason === "ALLOWED");
  if (reason === "ALLOWED") {
    expect(result.summary).toEqual(merge(EXPECTED_SUMMARY, summaryPatch));
    expect(Object.keys(result.summary).sort()).toEqual(
      ["candidateId", "experienceBand", "headline", "skills", "workPreference"]
    );
    expect(Array.isArray(result.summary.skills)).toBe(true);
  } else {
    expect(result.summary).toBeNull();
  }
}
