import { z } from "zod";

const line = (maximum: number) => z.string().trim().max(maximum)
  .regex(/^[^\u0000-\u001f\u007f]*$/);
const prose = (maximum: number) => z.string().max(maximum).regex(/^[^\u0000\u000b\u000c\u007f]*$/);
export const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const careerStages = ["Saved", "Applied", "Interviewing", "Offer", "Rejected", "Archived"] as const;
export type CareerStage = typeof careerStages[number];
export const documentKinds = ["resume", "cover_letter", "interview_prep"] as const;
export type DocumentKind = typeof documentKinds[number];
export const dateInputSchema = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  })]);

export const backgroundSchema = z.object({
  name: line(100),
  headline: line(160),
  email: z.union([z.literal(""), z.email().max(254)]),
  location: line(160),
  summary: prose(3000),
  skills: z.array(line(80).min(1)).max(30),
  experience: z.array(line(800).min(1)).max(30),
  education: z.array(line(300).min(1)).max(12),
}).strict();
export type CareerBackground = z.infer<typeof backgroundSchema>;
export const emptyBackground: CareerBackground = {
  name: "", headline: "", email: "", location: "", summary: "", skills: [], experience: [], education: [],
};
export const backgroundEditorSchema = backgroundSchema.omit({ skills: true, experience: true, education: true }).extend({
  skillsText: z.string().max(2500), experienceText: z.string().max(25000), educationText: z.string().max(4000),
});
export function backgroundEditorValues(facts: CareerBackground): z.infer<typeof backgroundEditorSchema> {
  return {
    name: facts.name, headline: facts.headline, email: facts.email, location: facts.location, summary: facts.summary,
    skillsText: facts.skills.join(", "), experienceText: facts.experience.join("\n"), educationText: facts.education.join("\n"),
  };
}
export const saveBackgroundSchema = z.object({
  content: backgroundSchema, expectedVersion: versionSchema,
}).strict();

export const jobSnapshotSchema = z.object({
  id: line(300).min(1),
  role: line(250).min(1),
  company: line(160).min(1),
  location: line(500),
  url: z.url().max(4096).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.port
        && url.hostname.includes(".") && !url.hostname.includes(":")
        && !/^\d+(?:\.\d+){3}$/.test(url.hostname)
        && !/(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname);
    } catch { return false; }
  }),
  source: z.enum(["greenhouse", "ashby", "lever"]),
  checkedAt: z.iso.datetime(),
}).strict();
export type CareerJobSnapshot = z.infer<typeof jobSnapshotSchema>;
export const saveWorkflowSchema = z.object({
  job: jobSnapshotSchema,
  stage: z.enum(careerStages),
  notes: prose(10000),
  nextAction: line(500),
  appliedDate: dateInputSchema,
  followUpDate: dateInputSchema,
  expectedVersion: versionSchema,
}).strict();
export type SaveWorkflow = z.infer<typeof saveWorkflowSchema>;

export const saveDocumentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(documentKinds),
  title: line(200).min(1),
  body: prose(50000).min(1),
  targetRole: line(250),
  targetCompany: line(160),
  sourceJobId: line(300).min(1).nullable(),
  expectedVersion: versionSchema,
}).strict();
export type SaveCareerDocument = z.infer<typeof saveDocumentSchema>;
export const removeDocumentSchema = z.object({
  id: z.uuid(), expectedVersion: versionSchema.refine(value => value >= 1),
}).strict();
export type CareerWorkflow = {
  job: CareerJobSnapshot; stage: CareerStage; notes: string; nextAction: string;
  appliedDate: string; followUpDate: string; version: number;
};
export type CareerDocument = Omit<SaveCareerDocument, "expectedVersion"> & { version: number };
export type CareerWorkspace = {
  background: { content: CareerBackground; version: number } | null;
  jobs: CareerWorkflow[];
  documents: CareerDocument[];
};
export const emptyWorkspace = (): CareerWorkspace => ({ background: null, jobs: [], documents: [] });

export type CareerJob = CareerJobSnapshot & {
  career: string; industry: string; region: string[];
  workplace: string; workplaceBasis: string; level: string; levelBasis: string;
  employment: string; travelPercent: number | null; travelEvidence: string | null;
  interviewSteps: number | null; interviewEvidence: string | null;
  min: number | null; max: number | null; payText: string | null;
  currency: string | null; payBasis: string; salaryNote: string | null;
  postedAt: string | null; sourceId: string; sourceUrl: string; sourceHome: string;
  applyUrl: string; availability: string; availabilityBasis: string;
  excerpt: string; descriptionTruncated: boolean;
};
export type CareerFeed = {
  jobs: CareerJob[];
  sources: { id: string; company: string; provider: string; status: string;
    checkedAt: string | null; attemptedAt: string; count: number | null }[];
  checkedAt: string; expiresAt: string; total: number; truncated: boolean;
  status: string; coverage: string; matching: string; cached: boolean;
};
export const jobSnapshot = (job: CareerJob): CareerJobSnapshot => ({
  id: job.id, role: job.role, company: job.company, location: job.location,
  url: job.url, source: job.source, checkedAt: job.checkedAt,
});

export type CareerFilters = {
  query: string; workplace: string; minimumPay: string; level: string; employment: string;
  industry: string; country: string; company: string; travel: string; interviews: string;
  posted: string; source: string; stage: string;
};
export const defaultCareerFilters: CareerFilters = {
  query: "", workplace: "", minimumPay: "", level: "", employment: "", industry: "",
  country: "", company: "", travel: "", interviews: "", posted: "", source: "", stage: "",
};
export function filterCareerJobs(jobs: CareerJob[], filters: CareerFilters,
  workflow: CareerWorkflow[] = [], now = Date.now()): CareerJob[] {
  const stages = new Map(workflow.map(item => [item.job.id, item.stage]));
  const query = filters.query.trim().toLocaleLowerCase();
  return jobs.filter(job => {
    if (query && ![job.role, job.company, job.location, job.career, job.excerpt].join(" ").toLocaleLowerCase().includes(query)) return false;
    if (filters.workplace && job.workplace !== filters.workplace) return false;
    if (filters.minimumPay && (job.payBasis !== "annual" || job.currency !== "USD" || job.min === null || job.min < Number(filters.minimumPay))) return false;
    if (filters.level && job.level !== filters.level) return false;
    if (filters.employment && job.employment !== filters.employment) return false;
    if (filters.industry && job.industry !== filters.industry) return false;
    if (filters.country && !job.region.includes(filters.country)) return false;
    if (filters.company && job.company !== filters.company) return false;
    if (filters.travel && (job.travelPercent === null || job.travelPercent > Number(filters.travel))) return false;
    if (filters.interviews && (job.interviewSteps === null || job.interviewSteps > Number(filters.interviews))) return false;
    if (filters.posted) {
      if (!job.postedAt) return false;
      const age = now - Date.parse(job.postedAt);
      if (!Number.isFinite(age) || age < 0 || age > Number(filters.posted) * 86400000) return false;
    }
    if (filters.source && job.availability !== filters.source) return false;
    if (filters.stage === "Untracked" && stages.has(job.id)) return false;
    if (filters.stage && filters.stage !== "Untracked" && stages.get(job.id) !== filters.stage) return false;
    return true;
  });
}
