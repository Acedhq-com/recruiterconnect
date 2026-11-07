import { z } from "zod";

export const PUBLIC_APP_ORIGIN = "https://findworkprivately.com";
export const PUBLIC_BRAND = "Find Work Privately";
const safeName = z.string().trim().min(2).max(80).regex(/^[^\u0000-\u001f\u007f]+$/);
export const accountEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const startEmailSchema = z.object({
  email: accountEmailSchema,
  captchaToken: z.string().max(4096).optional(),
}).strict();
export const verifyEmailSchema = z.object({
  email: accountEmailSchema,
  code: z.string().regex(/^\d{6,10}$/),
}).strict();
export const onboardAccountSchema = z.object({
  kind: z.enum(["candidate", "recruiter"]),
  displayName: safeName,
  acknowledgePrivateBeta: z.literal(true),
}).strict();
export const savePrivateProfileSchema = z.object({
  displayName: safeName,
  headline: z.string().trim().min(2).max(120).regex(/^[^\u0000-\u001f\u007f]+$/),
  skills: z.array(z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f]+$/)).max(12),
  workPreference: z.enum(["Remote", "Hybrid", "On-site"]),
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const companyName = z.string().trim().min(2).max(150).regex(/^[^\u0000-\u001f\u007f]+$/);
export const saveEmployerSchema = z.object({ employer: companyName }).strict();
export const addBlockSchema = z.object({ company: companyName }).strict();
export const removeBlockSchema = z.object({ id: z.uuid() }).strict();
export const MAX_BLOCKS = 50;
export const MAX_CLIENTS = 30;
// The database checks this exact value. Bumping it voids every earlier consent,
// so candidates must confirm again before they are visible.
export const DISCOVERY_CONSENT_VERSION = "discovery-v1";
const workPreference = z.enum(["Remote", "Hybrid", "On-site"]);
const proofLink = z.string().trim().max(300)
  .refine(value => value === "" || /^https:\/\/[^\s\u0000-\u001f\u007f]{4,}$/.test(value) && value.length >= 12,
    "Use a full https:// link.");
export const saveRecruiterFirmSchema = z.object({ firm: companyName, proofUrl: proofLink.optional() }).strict();
export const addClientSchema = z.object({ company: companyName }).strict();
export const removeClientSchema = z.object({ id: z.uuid() }).strict();
export const setDiscoverySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true), consentVersion: z.literal(DISCOVERY_CONSENT_VERSION) }).strict(),
  z.object({ enabled: z.literal(false) }).strict(),
]);
export const searchRequestSchema = z.object({
  query: z.string().trim().max(80).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  workPreference: workPreference.optional(),
  offset: z.number().int().min(0).max(100).optional(),
}).strict();
export const SEARCH_PAGE_SIZE = 20;
export const deletionRequestSchema = z.object({ confirmation: z.literal("DELETE") }).strict();
export const emptyAccountActionSchema = z.object({}).strict();
export type AccountKind = z.infer<typeof onboardAccountSchema>["kind"];
export type OnboardAccount = z.infer<typeof onboardAccountSchema>;
export type SavePrivateProfile = z.infer<typeof savePrivateProfileSchema>;

export type PrivateAccount = {
  user_id: string;
  account_kind: AccountKind;
  display_name: string;
  status: "active" | "deletion_requested" | "suspended";
  deletion_requested_at: string | null;
};
export type PrivateProfile = {
  headline: string;
  skills: string[];
  work_preference: "Remote" | "Hybrid" | "On-site";
  discovery_active: false;
  version: number;
};
export type PrivateBlock = { id: string; company_name: string; source: "current_employer" | "candidate" };
export type CandidatePrivacy = { current_employer: string | null; blocks: PrivateBlock[] };

export const recruiterStatuses = ["draft", "pending", "verified", "rejected", "suspended"] as const;
export type RecruiterStatus = (typeof recruiterStatuses)[number];
export type RecruiterClient = { id: string; company_name: string };
export type RecruiterRecord = {
  firm_name: string; proof_url: string | null; status: RecruiterStatus;
  submitted_at: string | null; verified_at: string | null; clients: RecruiterClient[];
};
export const recruiterRowSchema = z.object({
  firm_name: z.string().min(2).max(150), proof_url: z.string().max(300).nullable(),
  status: z.enum(recruiterStatuses), submitted_at: z.string().nullable(), verified_at: z.string().nullable(),
}).strict();
export const recruiterClientRowsSchema = z.array(z.object({
  id: z.uuid(), company_name: z.string().min(2).max(150),
}).strict()).max(MAX_CLIENTS);

export const discoveryBlockers = ["account_inactive", "profile_incomplete", "employer_missing",
  "mentions_blocked_company", "not_enabled", "consent_outdated", "awaiting_review",
  "review_rejected", "review_suspended"] as const;
export type DiscoveryBlocker = (typeof discoveryBlockers)[number];
export const discoveryStatusSchema = z.object({
  enabled: z.boolean(), review_status: z.enum(["pending", "approved", "rejected", "suspended"]),
  handle: z.string().regex(/^RC-[0-9A-F]{12}$/).nullable(), consent_version: z.string().max(40).nullable(),
  current_consent_version: z.string().max(40), ready: z.boolean(), visible: z.boolean(),
  blockers: z.array(z.enum(discoveryBlockers)).max(12),
}).strict();
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;

// The only fields a recruiter ever receives about a candidate. Strict on
// purpose: an unexpected column from the database is an error, not a pass-through.
export const searchCardSchema = z.object({
  handle: z.string().regex(/^RC-[0-9A-F]{12}$/), headline: z.string().min(1).max(120),
  skills: z.array(z.string().min(1).max(40)).max(12), work_preference: workPreference,
}).strict();
export type SearchCard = z.infer<typeof searchCardSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SetDiscovery = z.infer<typeof setDiscoverySchema>;
export type SaveRecruiterFirm = z.infer<typeof saveRecruiterFirmSchema>;
export type PublicAccountSession = {
  user: { id: string; email: string } | null;
  account: PrivateAccount | null;
  profile: PrivateProfile | null;
  privacy: CandidatePrivacy | null;
  recruiter: RecruiterRecord | null;
  discovery: DiscoveryStatus | null;
  authEnabled: boolean;
  appOrigin: string;
  method: "email-code";
};
