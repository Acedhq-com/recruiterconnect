import { z } from "zod";
import { AccountError } from "./account-service.js";
import { researchSearchSchema } from "../shared/research-schema.js";
import type { ResearchListing, ResearchResult, ResearchSearch } from "../shared/research-schema.js";

const MCP_URL = "https://api.reefapi.com/mcp";
const SEARCH_URL = "https://api.reefapi.com/linkedin-jobs/v1/jobs/search";
const ENGINE = "linkedin-jobs";
const ACTION = "jobs/search";
const MAX_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 22_000;
const sourceError = () => new AccountError(503,
  "The research source is unavailable. No replacement listings were invented and no jobs were marked closed.");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number): string | null =>
  typeof value === "string" && value.trim() ? value.slice(0, maximum) : null;

export interface IResearchService {
  allowed(userId: string): boolean;
  search(userId: string, input: ResearchSearch, remainingMs?: number): Promise<ResearchResult>;
}

async function body(response: Response): Promise<string> {
  if (!response.ok || response.redirected || !response.body) throw sourceError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let result = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw sourceError();
      result += decoder.decode(part.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function envelope(raw: string, eventStream: boolean, id: number): Record<string, unknown> {
  let messages: unknown[];
  if (eventStream) {
    messages = raw.replace(/\r\n/g, "\n").split("\n\n").flatMap(event => {
      const data = event.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
      return data ? [JSON.parse(data) as unknown] : [];
    });
  } else messages = [JSON.parse(raw) as unknown];
  const matching = messages.filter(value => record(value) && value.id === id);
  if (matching.length !== 1) throw sourceError();
  const message = matching[0];
  if (!record(message) || message.jsonrpc !== "2.0" || "error" in message || !record(message.result)) throw sourceError();
  return message.result;
}

function toolData(result: Record<string, unknown>): Record<string, unknown> {
  if (result.isError === true) throw sourceError();
  if (record(result.structuredContent)) return result.structuredContent;
  if (!Array.isArray(result.content)) throw sourceError();
  const items = result.content.filter((item: unknown) => record(item) && item.type === "text");
  if (items.length !== 1 || !record(items[0]) || typeof items[0].text !== "string") throw sourceError();
  const parsed: unknown = JSON.parse(items[0].text);
  if (!record(parsed)) throw sourceError();
  return parsed;
}

function validateAction(schema: Record<string, unknown>, params: Record<string, unknown>): void {
  if (schema.engine !== ENGINE || schema.action !== ACTION || !Array.isArray(schema.params)
    || !Array.isArray(schema.required_params) || !schema.required_params.includes("keywords")) throw sourceError();
  const specifications = new Map<string, Record<string, unknown>>();
  for (const item of schema.params) {
    if (!record(item) || typeof item.name !== "string" || specifications.has(item.name)) throw sourceError();
    specifications.set(item.name, item);
  }
  for (const required of schema.required_params) {
    if (typeof required !== "string" || !Object.hasOwn(params, required)) throw sourceError();
  }
  for (const [name, spec] of specifications) {
    if (spec.required === true && !Object.hasOwn(params, name)) throw sourceError();
  }
  for (const [name, value] of Object.entries(params)) {
    const spec = specifications.get(name);
    if (!spec) throw sourceError();
    if (spec.type === "string") {
      if (typeof value !== "string" || !value.trim()) throw sourceError();
    } else if (spec.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value)
        || (typeof spec.minimum === "number" && value < spec.minimum)
        || (typeof spec.maximum === "number" && value > spec.maximum)) throw sourceError();
    } else if (spec.type === "boolean") {
      if (typeof value !== "boolean") throw sourceError();
    } else if (spec.type === "enum") {
      if (!Array.isArray(spec.allowed_values)
        || !spec.allowed_values.some(item => record(item) && item.value === value)) throw sourceError();
    } else throw sourceError();
  }
}

function listing(raw: unknown, checkedAt: string): ResearchListing | null {
  if (!record(raw) || !record(raw.company)) return null;
  const id = text(raw.job_id, 128);
  const title = text(raw.title, 250);
  const company = text(raw.company.name, 160);
  if (!id || !title || !company || typeof raw.job_url !== "string" || raw.job_url.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw.job_url); } catch { return null; }
  if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname)
    || url.username || url.password || url.port || !/^\/jobs\/view\/[^/]+\/?$/.test(url.pathname)) return null;
  url.search = "";
  url.hash = "";
  const description = text(raw.description_text, 60_000);
  return {
    id: `linkedin:${id}`, source: "linkedin", provider: "reefapi", title, company,
    location: text(raw.location, 500), url: url.toString(), checkedAt,
    descriptionText: description, descriptionTruncated: typeof raw.description_text === "string" && raw.description_text.length > 60_000,
    workplaceLabel: text(raw.workplace_type, 160), workplaceBasis: text(raw.workplace_type_source, 160),
    // Do not infer a salary minimum from search pay bands, estimated pay,
    // a malformed object, or an annualized hourly number.
    salaryText: text(raw.salary, 1000), postedDateText: text(raw.posted_date, 160),
    providerState: text(raw.job_state, 160), verification: "discovered",
    matchScore: null, interviewChance: "not_checked", urgency: "not_checked",
  };
}

export class ReefResearchService implements IResearchService {
  #environment: NodeJS.ProcessEnv;
  #fetch: typeof fetch;
  #now: () => number;
  #nextSearch = new Map<string, number>();

  constructor(environment: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch, now = Date.now) {
    this.#environment = environment;
    this.#fetch = http;
    this.#now = now;
  }

  allowed(userId: string): boolean {
    if (this.#environment.REEFAPI_RESEARCH_ENABLED !== "1" || !this.#environment.REEFAPI_KEY?.trim()
      || !z.uuid().safeParse(userId).success) return false;
    const owners = (this.#environment.REEFAPI_RESEARCH_OWNER_IDS ?? "").split(",")
      .map(value => value.trim()).filter(value => z.uuid().safeParse(value).success);
    return owners.includes(userId);
  }

  async search(userId: string, raw: ResearchSearch, remainingMs = DEADLINE_MS): Promise<ResearchResult> {
    if (!this.allowed(userId)) throw new AccountError(403, "Research is not enabled for this candidate account.");
    const parsed = researchSearchSchema.safeParse(raw);
    if (!parsed.success) throw new AccountError(400, "Check the research keywords, location, filters, and result limit.");
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw sourceError();
    const started = this.#now();
    if ((this.#nextSearch.get(userId) ?? 0) > started) {
      throw new AccountError(429, "Wait one minute before another research search.");
    }
    // Beta cooldown only, not a durable commercial billing quota. Production
    // rollout still needs a cross-instance allowance before opening signup.
    this.#nextSearch.set(userId, started + 60_000);
    const signal = AbortSignal.timeout(Math.max(1, Math.min(DEADLINE_MS, Math.floor(remainingMs))));
    let sequence = 0;
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
    const rpc = async (method: string, params?: Record<string, unknown>, notify = false) => {
      const id = ++sequence;
      const response = await this.#fetch(MCP_URL, {
        method: "POST", headers, redirect: "error", signal,
        body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id }), method, ...(params ? { params } : {}) }),
      });
      if (!response.ok || response.redirected) throw sourceError();
      const sessionId = response.headers.get("Mcp-Session-Id");
      if (sessionId) headers.set("Mcp-Session-Id", sessionId);
      if (notify) {
        await response.body?.cancel();
        return {};
      }
      return envelope(await body(response), response.headers.get("content-type")?.includes("text/event-stream") ?? false, id);
    };
    const call = async (name: string, args: Record<string, unknown>) =>
      toolData(await rpc("tools/call", { name, arguments: args }));
    try {
      // Public, keyless schema discovery. The saved REST header key must never
      // be guessed into MCP Bearer auth or forwarded to an arbitrary tool.
      const initialized = await rpc("initialize", {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "FindWorkPrivately-JobResearch", version: "0.1.0" },
      });
      if (typeof initialized.protocolVersion !== "string" || initialized.protocolVersion.length > 64) throw sourceError();
      headers.set("MCP-Protocol-Version", initialized.protocolVersion);
      await rpc("notifications/initialized", undefined, true);
      const engine = await call("get_engine_schema", { engine: ENGINE });
      if (engine.engine !== ENGINE || engine.base_path !== "/linkedin-jobs/v1" || !Array.isArray(engine.actions)
        || !engine.actions.some(item => record(item) && item.action === ACTION)) throw sourceError();
      const schema = await call("get_action_schema", { engine: ENGINE, action: ACTION });
      const input = parsed.data;
      const params: Record<string, unknown> = {
        keywords: input.keywords, location: input.location, max_results: input.maxResults,
        date_posted: input.datePosted, include_detail: true,
        ...(input.workplace ? { workplace: input.workplace } : {}),
        ...(input.experience ? { experience: input.experience } : {}),
        ...(input.employment ? { job_type: input.employment } : {}),
      };
      validateAction(schema, params);
      if (!this.allowed(userId)) throw sourceError();
      const apiKey = this.#environment.REEFAPI_KEY!.trim();
      const response = await this.#fetch(SEARCH_URL, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(params),
      });
      const result: unknown = JSON.parse(await body(response));
      if (!record(result) || result.ok !== true || result.error != null || !record(result.data)
        || !Array.isArray(result.data.jobs) || result.data.jobs.length > input.maxResults) throw sourceError();
      const checkedAt = new Date(this.#now()).toISOString();
      const seen = new Set<string>();
      const jobs: ResearchListing[] = [];
      let droppedRecords = 0;
      const escapedKey = JSON.stringify(apiKey).slice(1, -1);
      for (const value of result.data.jobs) {
        if (JSON.stringify(value).includes(escapedKey)) { droppedRecords++; continue; }
        const normalized = listing(value, checkedAt);
        if (!normalized || seen.has(normalized.id) || seen.has(normalized.url)) { droppedRecords++; continue; }
        seen.add(normalized.id); seen.add(normalized.url); jobs.push(normalized);
      }
      const pagination = record(result.meta) && record(result.meta.pagination) ? result.meta.pagination : {};
      return { source: "linkedin", provider: "reefapi", checkedAt, jobs, droppedRecords,
        hasMore: typeof pagination.has_more === "boolean" ? pagination.has_more : null,
        matching: "not_run", verification: "employer_and_resume_review_required" };
    } catch {
      // Never return raw provider bodies, headers, auth failures, or exception
      // causes. Do not log queries, API keys, account JWTs, or source payloads.
      throw sourceError();
    }
  }
}

export const researchService = new ReefResearchService();
