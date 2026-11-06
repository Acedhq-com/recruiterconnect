import { readFileSync } from "node:fs";
import type { Summary } from "./reference.js";

export type JsonObject = Record<string, any>;
export type ContractCase = {
  id: string;
  category: string;
  expected: string;
  patch?: JsonObject;
  preset?: string;
  set?: JsonObject;
  remove?: string[];
  raw?: unknown;
  summary_patch?: JsonObject;
};
const root = new URL("../../", import.meta.url);
export const BASE: JsonObject = JSON.parse(readFileSync(new URL("shared/base.json", root), "utf8"));
export const CASES: ContractCase[] = JSON.parse(readFileSync(new URL("shared/cases.json", root), "utf8"));
export const PRESETS: JsonObject = JSON.parse(readFileSync(new URL("shared/presets.json", root), "utf8"));
export const EXPECTED_SUMMARY: Summary = structuredClone(BASE.candidate.summary);

export function merge(base: unknown, patch: unknown): any {
  if (base !== null && patch !== null && typeof base === "object" && typeof patch === "object"
      && !Array.isArray(base) && !Array.isArray(patch)) {
    let result: JsonObject = structuredClone(base);
    for (const [key, value] of Object.entries(patch)) {
      result = { ...result, [key]: merge(result[key], value) };
    }
    return result;
  }
  return structuredClone(patch);
}
export function context(patch: JsonObject = {}): JsonObject {
  return merge(BASE, patch);
}
export function materialize(testCase: ContractCase): unknown {
  const data = merge(context(PRESETS[testCase.preset ?? ""] ?? {}), testCase.patch ?? {});
  for (const [pointer, value] of Object.entries(testCase.set ?? {})) {
    const tokens = pointer.split("/").slice(1);
    const leaf = tokens.pop();
    if (leaf === undefined) throw new Error("Invalid fixture assignment");
    let parent: any = data;
    for (const token of tokens) parent = parent[token];
    parent[leaf] = structuredClone(value);
  }
  for (const pointer of testCase.remove ?? []) {
    const tokens = pointer.split("/").slice(1).map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
    const leaf = tokens.pop();
    if (leaf === undefined) throw new Error("Invalid fixture removal");
    let parent: any = data;
    for (const token of tokens) parent = parent[token];
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
    else delete parent[leaf];
  }
  return Object.hasOwn(testCase, "raw") ? testCase.raw : data;
}
