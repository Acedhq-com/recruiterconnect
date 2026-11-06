import { z } from "zod";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const industries = ["All fields", "Accounting & finance", "Technology", "Operations", "Marketing & design"] as const;
export const arrangements = ["Remote", "Hybrid", "On-site"] as const;
export const employmentTypes = ["Full-time", "Contract", "Part-time"] as const;
export const availabilityOptions = ["Any availability", "Immediately", "Within a month", "Exploring"] as const;

export type Candidate = {
  id: string;
  alias: string;
  role: string;
  industry: typeof industries[number];
  location: string;
  experience: number;
  salaryMin: number;
  salaryMax: number;
  arrangement: typeof arrangements[number];
  employment: typeof employmentTypes[number];
  availability: typeof availabilityOptions[number];
  skills: string[];
  description: string;
  highlights: string[];
  source: "sample";
};

export type Filters = {
  query: string;
  industry: string;
  location: string;
  arrangements: string[];
  employment: string;
  experienceMin: number;
  experienceMax: number;
  budget: number;
  availability: string;
};

export const defaultFilters: Filters = {
  query: "", industry: "All fields", location: "Anywhere",
  arrangements: [], employment: "Any type", experienceMin: 0,
  experienceMax: 20, budget: 250000, availability: "Any availability",
};

export const pilotLeads = pgTable("pilot_leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  organization: text("organization").notNull(),
  audience: text("audience").notNull(),
  plan: text("plan").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertPilotLeadSchema = createInsertSchema(pilotLeads)
  .omit({ id: true, createdAt: true })
  .extend({
    email: z.email().max(254).transform(value => value.trim().toLowerCase()),
    name: z.string().trim().min(2).max(100),
    organization: z.string().trim().min(2).max(150),
    audience: z.enum(["recruiter", "candidate"]),
    plan: z.enum(["candidate", "founding", "team"]),
    consent: z.literal(true, { error: "Please agree to be contacted about the pilot." }),
    website: z.string().max(0).optional(),
  }).strict();
export type InsertPilotLead = z.infer<typeof insertPilotLeadSchema>;
export type PilotLead = typeof pilotLeads.$inferSelect;

export type IntroRequest = {
  id: string;
  candidateId: string;
  role: string;
  company: string;
  salary: string;
  message: string;
  status: "Pending candidate approval" | "Withdrawn";
};

export type SavedSearch = { id: string; name: string; filters: Filters };

export function filterCandidates(candidates: Candidate[], filters: Filters): Candidate[] {
  const words = filters.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return candidates.filter(candidate => {
    const searchable = [candidate.role, candidate.industry, candidate.location, ...candidate.skills].join(" ").toLowerCase();
    return words.every(word => searchable.includes(word))
      && (filters.industry === "All fields" || candidate.industry === filters.industry)
      && (filters.location === "Anywhere" || candidate.location === filters.location)
      && (!filters.arrangements.length || filters.arrangements.includes(candidate.arrangement))
      && (filters.employment === "Any type" || candidate.employment === filters.employment)
      && candidate.experience >= filters.experienceMin
      && candidate.experience <= filters.experienceMax
      && candidate.salaryMin <= filters.budget
      && (filters.availability === "Any availability" || candidate.availability === filters.availability);
  });
}
