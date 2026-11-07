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
export type PublicAccountSession = {
  user: { id: string; email: string } | null;
  account: PrivateAccount | null;
  profile: PrivateProfile | null;
  authEnabled: boolean;
  appOrigin: string;
  method: "email-code";
};
