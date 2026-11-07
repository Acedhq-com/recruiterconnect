import { z } from "zod";

const queryText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .regex(/^[^\u0000-\u001f\u007f]*$/);

// No identity, resume text, company scope, credential, endpoint, or engine may
// come from this request. Search facets are not proof of listing eligibility.
export const researchSearchSchema = z.object({
  keywords: queryText(160),
  location: queryText(160),
  maxResults: z.number().int().min(1).max(20).default(20),
  datePosted: z.enum(["24h", "week", "month"]).default("week"),
  workplace: z.enum(["remote", "hybrid", "onsite"]).optional(),
  experience: z.enum(["internship", "entry", "associate", "mid_senior", "director", "executive"]).optional(),
  employment: z.enum(["fulltime", "parttime", "contract", "temporary", "internship", "volunteer", "other"]).optional(),
}).strict();
export type ResearchSearch = z.infer<typeof researchSearchSchema>;

export type ResearchListing = {
  id: string;
  source: "linkedin";
  provider: "reefapi";
  title: string;
  company: string;
  location: string | null;
  url: string;
  checkedAt: string;
  descriptionText: string | null;
  descriptionTruncated: boolean;
  workplaceLabel: string | null;
  workplaceBasis: string | null;
  salaryText: string | null;
  postedDateText: string | null;
  providerState: string | null;
  verification: "discovered";
  matchScore: null;
  interviewChance: "not_checked";
  urgency: "not_checked";
};
export type ResearchResult = {
  source: "linkedin";
  provider: "reefapi";
  checkedAt: string;
  jobs: ResearchListing[];
  droppedRecords: number;
  hasMore: boolean | null;
  matching: "not_run";
  verification: "employer_and_resume_review_required";
};

const percent = z.number().finite().min(0).max(100);
const annualSalary = z.number().finite().min(0);
export const researchEligibilityPolicySchema = z.object({
  remoteOnly: z.boolean(),
  minimumAnnualSalary: annualSalary.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  maximumTravelPercentExclusive: percent.nullable(),
  requireStateEligibility: z.boolean(),
}).strict();
export const researchEvidenceSchema = z.object({
  // "closed" requires affirmative, verified closure evidence. A 404, blocked
  // fetch, timeout, or missing search result is only "unavailable"/"not_checked".
  status: z.enum(["open", "closed", "unavailable", "not_checked"]),
  closureVerified: z.boolean(),
  workplace: z.enum(["remote", "hybrid", "onsite", "telework", "unknown"]),
  countryEligibility: z.enum(["confirmed", "excluded", "unknown"]),
  stateEligibility: z.enum(["confirmed", "excluded", "unknown"]),
  salaryMinimum: annualSalary.nullable(),
  salaryCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  salaryBasis: z.enum(["annual", "hourly", "unknown"]),
  salaryProvenance: z.enum(["employer_posted", "estimate", "unknown"]),
  travelMaximumPercent: percent.nullable(),
  commissionOnly: z.boolean().nullable(),
}).strict();
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>;
export type ResearchEligibilityPolicy = z.infer<typeof researchEligibilityPolicySchema>;

export function classifyResearchEvidence(evidenceInput: ResearchEvidence, policyInput: ResearchEligibilityPolicy): {
  disposition: "active" | "hidden" | "archived";
  reasons: string[];
  unknowns: string[];
} {
  const evidence = researchEvidenceSchema.parse(evidenceInput);
  const policy = researchEligibilityPolicySchema.parse(policyInput);
  if (evidence.status === "closed" && evidence.closureVerified) {
    return { disposition: "archived", reasons: ["Verified closed listing"], unknowns: [] };
  }
  const reasons: string[] = [];
  const unknowns: string[] = [];
  if (evidence.status !== "open") reasons.push("Listing availability is not verified");
  if (policy.remoteOnly && evidence.workplace !== "remote") reasons.push("Not verified fully remote");
  if (evidence.countryEligibility !== "confirmed") reasons.push("Country eligibility is not confirmed");
  // An explicit state exclusion always wins, even if nationwide eligibility
  // otherwise appears confirmed. Null/unknown scopes are not universal grants.
  if (evidence.stateEligibility === "excluded"
    || (policy.requireStateEligibility && evidence.stateEligibility !== "confirmed")) {
    reasons.push("State eligibility is not confirmed");
  }
  if (policy.minimumAnnualSalary !== null && (
    evidence.salaryProvenance !== "employer_posted" || evidence.salaryBasis !== "annual"
    || evidence.salaryCurrency !== policy.currency || evidence.salaryMinimum === null
    || evidence.salaryMinimum < policy.minimumAnnualSalary
  )) reasons.push("Employer-posted annual salary minimum does not satisfy this profile");
  if (policy.maximumTravelPercentExclusive !== null && evidence.travelMaximumPercent !== null
    && evidence.travelMaximumPercent >= policy.maximumTravelPercentExclusive) {
    reasons.push("Stated travel exceeds this profile");
  }
  if (evidence.commissionOnly === true) reasons.push("Commission-only work");
  if (evidence.travelMaximumPercent === null) unknowns.push("Travel not stated");
  if (evidence.commissionOnly === null) unknowns.push("Compensation structure not checked");
  return { disposition: reasons.length ? "hidden" : "active", reasons, unknowns };
}

// Preserve the supplied workflow's rubric, but do not manufacture assessments.
// Resume-based scoring and urgency collection are a later, separately verified
// stage; a successful search alone always returns matchScore: null.
export const researchScoreWeights = Object.freeze({
  track: 30, remoteEligibility: 20, seniority: 15, duties: 10,
  resumeQualifications: 10, salary: 5, recency: 5, stability: 5,
});
