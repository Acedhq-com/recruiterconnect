import { describe, expect, it } from "vitest";
import { classifyResearchEvidence, researchScoreWeights, researchSearchSchema } from "../shared/research-schema.js";
import type { ResearchEligibilityPolicy, ResearchEvidence } from "../shared/research-schema.js";

const policy: ResearchEligibilityPolicy = {
  remoteOnly: true, minimumAnnualSalary: 70_000, currency: "USD",
  maximumTravelPercentExclusive: 20, requireStateEligibility: true,
};
const evidence: ResearchEvidence = {
  status: "open", closureVerified: false, workplace: "remote",
  countryEligibility: "confirmed", stateEligibility: "confirmed",
  salaryMinimum: 70_000, salaryCurrency: "USD", salaryBasis: "annual",
  salaryProvenance: "employer_posted", travelMaximumPercent: 10, commissionOnly: false,
};

describe("workflow-derived research evidence rules", () => {
  it("keeps a lead only when this profile's hard constraints are actually satisfied", () => {
    expect(classifyResearchEvidence(evidence, policy)).toEqual({ disposition: "active", reasons: [], unknowns: [] });
  });
  it.each(["hybrid", "onsite", "telework", "unknown"] as const)("does not treat %s as verified fully remote", workplace => {
    expect(classifyResearchEvidence({ ...evidence, workplace }, policy).disposition).toBe("hidden");
  });
  it("allows another user's explicit non-remote profile without installing personal defaults", () => {
    expect(classifyResearchEvidence({ ...evidence, workplace: "hybrid" }, { ...policy, remoteOnly: false }).disposition).toBe("active");
  });
  it.each(["excluded", "unknown"] as const)("does not infer U.S. eligibility from %s country scope", countryEligibility => {
    expect(classifyResearchEvidence({ ...evidence, countryEligibility }, policy).disposition).toBe("hidden");
  });
  it("gives an explicit state exclusion precedence over a confirmed nationwide scope", () => {
    expect(classifyResearchEvidence({ ...evidence, stateEligibility: "excluded" }, { ...policy, requireStateEligibility: false }).disposition).toBe("hidden");
  });
  it("does not treat unknown state scope as a universal allow grant", () => {
    expect(classifyResearchEvidence({ ...evidence, stateEligibility: "unknown" }, policy).disposition).toBe("hidden");
  });
  it.each([
    { salaryMinimum: null }, { salaryMinimum: 69_999 }, { salaryCurrency: null },
    { salaryCurrency: "EUR" }, { salaryProvenance: "estimate" }, { salaryProvenance: "unknown" },
    { salaryBasis: "hourly" }, { salaryBasis: "unknown" },
  ] as Partial<ResearchEvidence>[])("does not promote missing, estimated, below-floor, or nonannual pay %#", changed => {
    expect(classifyResearchEvidence({ ...evidence, ...changed }, policy).disposition).toBe("hidden");
  });
  it("allows undisclosed pay only when the user's profile explicitly has no salary floor", () => {
    expect(classifyResearchEvidence({ ...evidence, salaryMinimum: null }, { ...policy, minimumAnnualSalary: null }).disposition).toBe("active");
  });
  it.each([20, 21, 100])("enforces the supplied strict travel ceiling at %s percent", travelMaximumPercent => {
    expect(classifyResearchEvidence({ ...evidence, travelMaximumPercent }, policy).disposition).toBe("hidden");
  });
  it("labels unstated travel as unknown rather than inventing zero travel", () => {
    expect(classifyResearchEvidence({ ...evidence, travelMaximumPercent: null }, policy)).toMatchObject({
      disposition: "active", unknowns: ["Travel not stated"],
    });
  });
  it("excludes known commission-only work and discloses an unchecked structure", () => {
    expect(classifyResearchEvidence({ ...evidence, commissionOnly: true }, policy).disposition).toBe("hidden");
    expect(classifyResearchEvidence({ ...evidence, commissionOnly: null }, policy).unknowns).toContain("Compensation structure not checked");
  });
  it.each(["unavailable", "not_checked", "closed"] as const)("does not archive %s without affirmative closure proof", status => {
    expect(classifyResearchEvidence({ ...evidence, status }, policy).disposition).toBe("hidden");
  });
  it("archives only an affirmatively verified closed listing", () => {
    expect(classifyResearchEvidence({ ...evidence, status: "closed", closureVerified: true }, policy).disposition).toBe("archived");
  });
  it("does not use an old closure flag to turn a current source failure into closure", () => {
    expect(classifyResearchEvidence({ ...evidence, status: "unavailable", closureVerified: true }, policy).disposition).toBe("hidden");
  });
  it.each([NaN, Infinity, -1])("rejects malformed numerical evidence rather than granting eligibility: %s", salaryMinimum => {
    expect(() => classifyResearchEvidence({ ...evidence, salaryMinimum }, policy)).toThrow();
  });
  it("preserves the 100-point rubric without asserting that a search computed a score", () => {
    expect(Object.values(researchScoreWeights).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(Object.isFrozen(researchScoreWeights)).toBe(true);
  });
});

describe("strict research input contract", () => {
  it("requires a user's role and geography rather than imposing the owner's personal profile", () => {
    expect(researchSearchSchema.safeParse({}).success).toBe(false);
    expect(researchSearchSchema.parse({ keywords: "Product Designer", location: "Canada" })).toEqual({
      keywords: "Product Designer", location: "Canada", maxResults: 20, datePosted: "week",
    });
  });
  it.each([
    { keywords: "" }, { keywords: null }, { keywords: "x\ninjected" }, { location: null },
    { maxResults: 0 }, { maxResults: 21 }, { maxResults: 1.5 }, { workplace: "fully_remote" },
    { datePosted: "yesterday" }, { experience: "senior" }, { employment: "full-time" },
    { user_id: "foreign" }, { company_id: "foreign" }, { endpoint: "https://evil.example" },
    { engine: "unrelated-api" }, { apiKey: "not accepted" }, { resume: "do not send" },
  ])("rejects invalid, unsupported, or owner/credential-bearing input %#", changed => {
    expect(researchSearchSchema.safeParse({ keywords: "Analyst", location: "US", ...changed }).success).toBe(false);
  });
});
