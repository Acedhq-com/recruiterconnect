import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { backgroundSchema, emptyBackground, jobSnapshotSchema } from "../shared/career-schema.js";

type Case = { id: string; patch: Record<string, unknown>; valid: boolean };
const corpus = JSON.parse(readFileSync(
  new URL("../shared/career-validation-cases.json", import.meta.url), "utf8",
)) as { version: number; background: Case[]; snapshot: Case[] };
const snapshot = { id: "audit-job", role: "Synthetic role", company: "Audit employer",
  location: "Remote", url: "https://jobs.example.com/audit", source: "ashby",
  checkedAt: "2026-11-07T00:00:00.000Z" };

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).length === 2 && typeof entry.repeat === "string"
      && typeof entry.times === "number" && Number.isInteger(entry.times)
      && entry.times >= 0 && entry.times <= 50001) return entry.repeat.repeat(entry.times);
    return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, expand(child)]));
  }
  return value;
}

test("career validation corpus is explicitly versioned and nonempty", () => {
  expect(corpus.version).toBe(1);
  expect(corpus.background.length).toBeGreaterThan(20);
  expect(corpus.snapshot.length).toBeGreaterThan(20);
});
test.each(corpus.background)("background admission: $id", entry => {
  const value = { ...emptyBackground, ...expand(entry.patch) as Record<string, unknown> };
  expect(backgroundSchema.safeParse(value).success).toBe(entry.valid);
});
test.each(corpus.snapshot)("snapshot admission: $id", entry => {
  const value = { ...snapshot, ...expand(entry.patch) as Record<string, unknown> };
  expect(jobSnapshotSchema.safeParse(value).success).toBe(entry.valid);
});
