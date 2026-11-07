import { describe, expect, it } from "vitest";
import {
  backgroundEditorSchema, backgroundEditorValues, backgroundSchema, defaultCareerFilters, emptyBackground, filterCareerJobs,
  jobSnapshot, saveBackgroundSchema, saveDocumentSchema, saveWorkflowSchema,
} from "../shared/career-schema.js";
import type { CareerFilters, CareerWorkflow } from "../shared/career-schema.js";
import { generateMaterial, plainMaterial } from "../shared/application-materials.js";
import { csvCell } from "../client/src/lib/export.js";

import { checked, testJob } from "./career-fixtures.js";
const now = Date.parse(checked);
const facts = { ...emptyBackground, name: "QA Person", headline: "Operations analyst",
  summary: "I analyze operations using actual documented evidence.",
  skills: ["Excel", "SQL"], experience: ["Employer A | Analyst | 2022-2026: Reconciled records using Excel.", "Reviewed source records."],
  education: ["Example degree, completed 2022"] };
const target = { role: "Senior Analyst", company: "QA Employer", excerpt: "Excel and operations analysis." };

describe("career filtering and unknown evidence", () => {
  it.each([
    ["workplace", "Remote"], ["minimumPay", "90000"], ["level", "Senior"], ["employment", "Full-time"],
    ["industry", "Software"], ["country", "US"], ["company", "QA Employer"], ["travel", "10"],
    ["interviews", "3"], ["posted", "7"], ["source", "employer_listed"],
  ] as const)("combines a supported %s filter", (key, value) => {
    expect(filterCareerJobs([testJob], { ...defaultCareerFilters, [key]: value }, [], now)).toHaveLength(1);
  });
  it("combines all constraints rather than unioning scopes", () => {
    const filters: CareerFilters = { ...defaultCareerFilters, workplace: "Remote", minimumPay: "90000", company: "Different Employer" };
    expect(filterCareerJobs([testJob], filters, [], now)).toEqual([]);
  });
  it.each([
    { min: null }, { min: 150000, currency: "EUR" }, { min: 90, payBasis: "hourly" },
  ])("never promotes unknown/nonannual USD pay into a salary floor", change => {
    expect(filterCareerJobs([{ ...testJob, ...change }], { ...defaultCareerFilters, minimumPay: "70000" }, [], now)).toEqual([]);
  });
  it.each(["travel", "interviews"] as const)("excludes null %s from numeric caps", key => {
    expect(filterCareerJobs([{ ...testJob, travelPercent: null, interviewSteps: null }],
      { ...defaultCareerFilters, [key]: "3" }, [], now)).toEqual([]);
  });
  it("does not treat hybrid as remote", () => {
    expect(filterCareerJobs([{ ...testJob, workplace: "Hybrid" }], { ...defaultCareerFilters, workplace: "Remote" })).toEqual([]);
  });
  it.each([null, "invalid", "2026-12-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"])("rejects unsupported publication dates %s", postedAt => {
    expect(filterCareerJobs([{ ...testJob, postedAt }], { ...defaultCareerFilters, posted: "7" }, [], now)).toEqual([]);
  });
  it("uses the caller's private workflow and never another scope", () => {
    const own: CareerWorkflow = { job: jobSnapshot(testJob), stage: "Applied", notes: "", nextAction: "", appliedDate: "", followUpDate: "", version: 1 };
    expect(filterCareerJobs([testJob], { ...defaultCareerFilters, stage: "Applied" }, [own], now)).toHaveLength(1);
    expect(filterCareerJobs([testJob], { ...defaultCareerFilters, stage: "Applied" }, [], now)).toEqual([]);
    expect(filterCareerJobs([testJob], { ...defaultCareerFilters, stage: "Untracked" }, [own], now)).toEqual([]);
  });
  it("matches keywords case-insensitively without mutating source records", () => {
    const before = JSON.stringify(testJob);
    expect(filterCareerJobs([testJob], { ...defaultCareerFilters, query: "  excel  " })).toHaveLength(1);
    expect(JSON.stringify(testJob)).toBe(before);
  });
});

describe("strict private workspace validation", () => {
  const workflow = { job: jobSnapshot(testJob), stage: "Saved", notes: "", nextAction: "", appliedDate: "", followUpDate: "", expectedVersion: 0 };
  it("accepts empty background without inventing experience", () => expect(backgroundSchema.parse(emptyBackground)).toEqual(emptyBackground));
  it("supplies exact editor defaults without unregistered array fields rejected by strict validation", () => {
    const editor = backgroundEditorValues(facts);
    expect(backgroundEditorSchema.safeParse(editor).success).toBe(true);
    expect(editor).not.toHaveProperty("skills");
    expect(editor).not.toHaveProperty("experience");
    expect(editor.experienceText).toContain("Reconciled records using Excel.");
  });
  it.each(["user_id", "company_id", "discovery_active", "admin"])("rejects caller-selected %s scope", key => {
    expect(saveWorkflowSchema.safeParse({ ...workflow, [key]: "other" }).success).toBe(false);
    expect(saveBackgroundSchema.safeParse({ content: facts, expectedVersion: 0, [key]: "other" }).success).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null])("rejects invalid version %s", expectedVersion => {
    expect(saveWorkflowSchema.safeParse({ ...workflow, expectedVersion }).success).toBe(false);
  });
  it.each(["2026-02-30", "2026-99-01", "yesterday", "2026-1-01"])("rejects invalid date %s", appliedDate => {
    expect(saveWorkflowSchema.safeParse({ ...workflow, appliedDate }).success).toBe(false);
  });
  it("accepts a real leap date and preserves explicit blank dates", () => {
    expect(saveWorkflowSchema.parse({ ...workflow, appliedDate: "2028-02-29" }).followUpDate).toBe("");
  });
  it.each(["javascript:alert(1)", "http://example.com/", "https://u:p@example.com/", "https://127.0.0.1/"])("rejects unsafe outbound snapshot URL %s", url => {
    expect(saveWorkflowSchema.safeParse({ ...workflow, job: { ...workflow.job, url } }).success).toBe(false);
  });
  it("keeps formulas and multiline notes literal for private storage", () => {
    const notes = '=HYPERLINK("https://example.com")\n+1';
    expect(saveWorkflowSchema.parse({ ...workflow, notes }).notes).toBe(notes);
    expect(csvCell(notes)).toMatch(/^"'/);
  });
  it("bounds document storage and rejects forged owner fields", () => {
    const doc = { id: "11111111-1111-4111-8111-111111111111", kind: "resume", title: "Draft", body: "Facts",
      targetRole: "", targetCompany: "", sourceJobId: null, expectedVersion: 0 };
    expect(saveDocumentSchema.safeParse({ ...doc, body: "x".repeat(50001) }).success).toBe(false);
    expect(saveDocumentSchema.safeParse({ ...doc, user_id: "foreign" }).success).toBe(false);
  });
});

describe("fact-only portable application materials", () => {
  it.each(["resume", "cover_letter", "interview_prep"] as const)("creates %s using supported facts, not fictional qualifications", kind => {
    const output = generateMaterial(kind, facts, target);
    expect(output.method).toBe("local-facts");
    expect(output.body).toContain(facts.experience[0]);
    expect(output.body).not.toMatch(/\b(?:CPA|MBA|PhD|increased revenue by|80% chance)\b/);
    expect(output.supportedSkills).toEqual(["Excel"]);
  });
  it("does not promote skills from a posting into the person's background", () => {
    const output = generateMaterial("resume", facts, { ...target, excerpt: "CPA Python Kubernetes" });
    expect(output.supportedSkills).toEqual([]);
    expect(output.body).not.toMatch(/CPA|Python|Kubernetes/);
  });
  it("preserves facts verbatim, including punctuation and potentially adversarial text", () => {
    const input = { ...facts, experience: ['=1+1 "quoted"', "<script>not executed</script>"] };
    const output = generateMaterial("resume", input, target);
    expect(output.body).toContain(input.experience[0]);
    expect(output.body).toContain(input.experience[1]);
  });
  it.each([{ ...facts, name: "" }, { ...facts, summary: "", experience: [] }])("requires minimum actual background", input => {
    expect(() => generateMaterial("resume", input, target)).toThrow();
  });
  it("requires a target role", () => expect(() => generateMaterial("resume", facts, { ...target, role: "" })).toThrow());
  it("does not mutate source facts or reuse a stateful regex across documents", () => {
    const before = JSON.stringify(facts);
    const first = generateMaterial("resume", facts, target);
    expect(generateMaterial("resume", facts, target)).toEqual(first);
    expect(JSON.stringify(facts)).toBe(before);
  });
  it("plain export removes markdown headings without deleting literal experience", () => {
    const output = plainMaterial(generateMaterial("resume", facts, target).body);
    expect(output).not.toMatch(/^#/m);
    expect(output).toContain(facts.experience[0]);
  });
});
