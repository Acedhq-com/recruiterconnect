import { expect, test } from "vitest";
import fc from "fast-check";
import { candidates } from "../shared/candidates.js";
import { defaultFilters, filterCandidates, insertPilotLeadSchema } from "../shared/schema.js";
import type { Filters } from "../shared/schema.js";
import { csvCell, shortlistCsv } from "../client/src/lib/export.js";

const search = (patch: Partial<Filters>) => filterCandidates(candidates, { ...defaultFilters, ...patch });

test("all fictional profiles appear with no filters", () => {
  expect(search({})).toHaveLength(12);
  expect(candidates.every(candidate => candidate.source === "sample")).toBe(true);
});
test.each(["SQL", "sql", " SQL "])("role/skill search normalizes %j", query => {
  expect(search({ query }).every(candidate => candidate.skills.some(skill => skill.toLowerCase().includes("sql")))).toBe(true);
  expect(search({ query })).not.toHaveLength(0);
});
test("each search word is required, with no accidental wildcard", () => {
  expect(search({ query: "senior accountant" }).map(candidate => candidate.id)).toEqual(["RC-1086"]);
  expect(search({ query: "unmatchable *" })).toEqual([]);
});
test("category, metro, work arrangement, and employment intersect", () => {
  const results = search({ industry: "Accounting & finance", location: "Chicago, IL", arrangements: ["Remote"], employment: "Full-time" });
  expect(results.map(candidate => candidate.id)).toEqual(["RC-1042", "RC-1452"]);
});
test("multiple arrangements are an OR within their own dimension", () => {
  expect(search({ arrangements: ["Remote", "Hybrid"] }).length).toBe(11);
});
test("experience boundaries are inclusive", () => {
  expect(search({ experienceMin: 5, experienceMax: 5 }).map(candidate => candidate.id)).toEqual(["RC-1086", "RC-1173"]);
});
test("minimum desired salary determines budget fit", () => {
  expect(search({ budget: 90000 }).map(candidate => candidate.id)).toEqual(["RC-1086", "RC-1320", "RC-1452", "RC-1496"]);
});
test("availability is an exact job-related filter", () => {
  expect(search({ availability: "Immediately" }).every(candidate => candidate.availability === "Immediately")).toBe(true);
});
test("filtering never mutates the directory", () => {
  const snapshot = structuredClone(candidates);
  search({ budget: 90000 });
  expect(candidates).toEqual(snapshot);
});
test("property: tightening a budget cannot add candidates", () => {
  fc.assert(fc.property(fc.integer({ min: 60000, max: 250000 }), budget => {
    const lower = new Set(search({ budget }).map(candidate => candidate.id));
    const higher = new Set(search({ budget: budget + 10000 }).map(candidate => candidate.id));
    expect([...lower].every(id => higher.has(id))).toBe(true);
  }), { seed: 20261106, numRuns: 150 });
});
test("export has only anonymous sample fields", () => {
  const csv = shortlistCsv(candidates.slice(0, 1));
  expect(csv).toContain("Synthetic sample");
  for (const key of ["email", "fullName", "currentEmployer", "linkedin", "identity_grants"]) {
    expect(csv).not.toContain(key);
  }
});
test.each(["=SUM(A1)", "+cmd", "-cmd", "@SUM(A1)", " =1", "\t=1", "\r=1"])(
  "CSV formula prefix %j is neutralized", value => {
    expect(csvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
  }
);
test("CSV quotes commas, newlines, and double quotes", () => {
  expect(csvCell('text, "quoted"\nnext')).toBe('"text, ""quoted""\nnext"');
});
const validLead = { name: "Example Person", email: "person@example.com", organization: "Example Company", audience: "recruiter", plan: "founding", consent: true, website: "" };
test("pilot schema accepts a valid contact request", () => {
  expect(insertPilotLeadSchema.safeParse(validLead).success).toBe(true);
});
test.each([
  { email: "bad" }, { consent: false }, { organization: "" }, { website: "spam.example" },
  { plan: "enterprise" }, { name: "" }, { email: "a@example.com\nBcc:a@example.com" },
  { role: "admin" },
])("pilot schema rejects malformed and extra authority fields %j", patch => {
  expect(insertPilotLeadSchema.safeParse({ ...validLead, ...patch }).success).toBe(false);
});
