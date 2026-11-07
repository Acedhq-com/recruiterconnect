import { describe, expect, it, vi } from "vitest";
import { ReefResearchService } from "../server/research-service.js";
import { researchSearchSchema } from "../shared/research-schema.js";

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const key = "synthetic-unit-test-key";
const request = researchSearchSchema.parse({
  keywords: "Operations Analyst", location: "United States", workplace: "remote", maxResults: 3,
});
const engine = {
  engine: "linkedin-jobs", base_path: "/linkedin-jobs/v1", actions: [{ action: "jobs/search" }],
};
const action = {
  engine: "linkedin-jobs", action: "jobs/search", required_params: ["keywords"],
  params: [
    { name: "keywords", type: "string", required: true },
    { name: "location", type: "string" },
    { name: "max_results", type: "integer", minimum: 1, maximum: 1000 },
    { name: "date_posted", type: "enum", allowed_values: ["24h", "week", "month"].map(value => ({ value })) },
    { name: "workplace", type: "enum", allowed_values: ["remote", "onsite", "hybrid"].map(value => ({ value })), on_invalid: "ignore" },
    { name: "experience", type: "enum", allowed_values: [{ value: "mid_senior" }] },
    { name: "job_type", type: "enum", allowed_values: [{ value: "fulltime" }] },
    { name: "include_detail", type: "boolean" },
  ],
};
const job = {
  job_id: "90001", job_url: "https://www.linkedin.com/jobs/view/90001/?trackingId=remove#fragment",
  title: "Operations Analyst", company: { name: "Synthetic Test Employer" }, location: "United States",
  workplace_type: "Remote", workplace_type_source: "search_filter",
  description_text: 'Literal text: =1+1\n<script>do not execute</script> / naïve résumé / 日本語',
  description_html: "<script>not returned</script>", job_state: "active",
  job_poster: { name: "Do not return this contact", profile_url: "https://www.linkedin.com/in/test" },
};
type Options = {
  env?: NodeJS.ProcessEnv;
  engine?: Record<string, unknown>;
  action?: Record<string, unknown>;
  jobs?: unknown[];
  result?: unknown;
  restStatus?: number;
  sse?: boolean;
  brokenMcpId?: boolean;
  duplicateMcpId?: boolean;
  mcpIsError?: boolean;
  oversized?: boolean;
};
function fixture(options: Options = {}) {
  const calls: { url: string; headers: Headers; init: RequestInit; payload: Record<string, unknown> }[] = [];
  const http = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, headers: new Headers(init.headers), init, payload });
    if (url.endsWith("/mcp")) {
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (payload.method === "initialize") result = { protocolVersion: "2025-03-26" };
      else {
        const params = payload.params as { name: string };
        const data = params.name === "get_engine_schema" ? options.engine ?? engine : options.action ?? action;
        result = { content: [{ type: "text", text: JSON.stringify(data) }], isError: options.mcpIsError ?? false };
      }
      const message = { jsonrpc: "2.0", id: options.brokenMcpId ? 999 : payload.id, result };
      if (options.sse) {
        const value = `: keepalive\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`
          + (options.duplicateMcpId ? `data: ${JSON.stringify(message)}\n\n` : "");
        return new Response(value, { headers: { "content-type": "text/event-stream", "Mcp-Session-Id": "synthetic-mcp-session" } });
      }
      return Response.json(message);
    }
    if (options.oversized) return new Response("x".repeat(2 * 1024 * 1024 + 1));
    return Response.json(options.result ?? {
      ok: true, error: null, data: { jobs: options.jobs ?? [job] },
      meta: { pagination: { has_more: true, next_cursor: "not-returned" }, request_headers: { secret: "not-returned" } },
    }, { status: options.restStatus ?? 200 });
  });
  let clock = Date.parse("2026-11-07T12:00:00Z");
  const env = options.env ?? { REEFAPI_RESEARCH_ENABLED: "1", REEFAPI_KEY: key, REEFAPI_RESEARCH_OWNER_IDS: `${userA}, ${userB}` };
  const service = new ReefResearchService(env, http, () => clock);
  return { service, http, calls, advance: (ms: number) => { clock += ms; }, env,
    paid: () => calls.filter(call => !call.url.endsWith("/mcp")) };
}

describe("ReefAPI schema-first server-only adapter", () => {
  it("uses keyless discovery followed by only the pinned REST search endpoint", async () => {
    const f = fixture();
    const result = await f.service.search(userA, request);
    expect(f.calls.map(call => call.url)).toEqual([
      ...Array<string>(4).fill("https://api.reefapi.com/mcp"),
      "https://api.reefapi.com/linkedin-jobs/v1/jobs/search",
    ]);
    expect(f.calls.slice(0, 4).every(call => !call.headers.has("x-api-key") && !call.headers.has("Authorization"))).toBe(true);
    expect(f.paid()[0]!.headers.get("x-api-key")).toBe(key);
    expect(f.calls.every(call => call.init.redirect === "error")).toBe(true);
    expect(f.calls.every(call => call.init.signal === f.calls[0]!.init.signal)).toBe(true);
    expect(f.paid()[0]!.payload).toEqual({
      keywords: "Operations Analyst", location: "United States", max_results: 3, date_posted: "week",
      workplace: "remote", include_detail: true,
    });
    expect(JSON.stringify(f.calls.map(call => ({ url: call.url, payload: call.payload })))).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(f.service)).not.toContain(key);
  });
  it("does not mistake search facets for verified eligibility, scoring, or urgency", async () => {
    const { service } = fixture();
    const result = await service.search(userA, request);
    expect(result.jobs[0]).toMatchObject({
      source: "linkedin", provider: "reefapi", verification: "discovered", matchScore: null,
      interviewChance: "not_checked", urgency: "not_checked", salaryText: null,
      workplaceLabel: "Remote", workplaceBasis: "search_filter",
    });
    expect(result.matching).toBe("not_run");
    expect(result.verification).toBe("employer_and_resume_review_required");
    expect(result.hasMore).toBe(true);
  });
  it("preserves literal Unicode and multiline text without returning HTML or contact data", async () => {
    const result = await fixture({ sse: true }).service.search(userA, request);
    expect(result.jobs[0]!.descriptionText).toBe(job.description_text);
    expect(result.jobs[0]!.url).toBe("https://www.linkedin.com/jobs/view/90001/");
    expect(JSON.stringify(result)).not.toContain("job_poster");
    expect(JSON.stringify(result)).not.toContain("description_html");
    expect(JSON.stringify(result)).not.toContain("request_headers");
    expect(JSON.stringify(result)).not.toContain("Do not return this contact");
  });
  it.each([
    {}, { REEFAPI_KEY: key }, { REEFAPI_RESEARCH_ENABLED: "1", REEFAPI_KEY: key },
    { REEFAPI_RESEARCH_ENABLED: "1", REEFAPI_KEY: " ", REEFAPI_RESEARCH_OWNER_IDS: userA },
    { REEFAPI_RESEARCH_ENABLED: "0", REEFAPI_KEY: key, REEFAPI_RESEARCH_OWNER_IDS: userA },
    { REEFAPI_RESEARCH_ENABLED: "1", REEFAPI_KEY: key, REEFAPI_RESEARCH_OWNER_IDS: "*" },
  ])("fails closed before any network request for incomplete configuration %#", async env => {
    const f = fixture({ env });
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 403 });
    expect(f.http).not.toHaveBeenCalled();
  });
  it.each(["", "invalid", `${userA}suffix`, "33333333-3333-4333-8333-333333333333"])("does not grant a partial, null, or foreign owner scope: %s", async owner => {
    const f = fixture();
    expect(f.service.allowed(owner)).toBe(false);
    await expect(f.service.search(owner, request)).rejects.toMatchObject({ status: 403 });
    expect(f.http).not.toHaveBeenCalled();
  });
  it.each([null, undefined])("does not promote a missing owner to a universal scope: %s", async owner => {
    const f = fixture();
    expect(f.service.allowed(owner as never)).toBe(false);
    await expect(f.service.search(owner as never, request)).rejects.toMatchObject({ status: 403 });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("validates caller inputs again at the service boundary", async () => {
    const f = fixture();
    await expect(f.service.search(userA, { ...request, maxResults: 1000 })).rejects.toMatchObject({ status: 400 });
    expect(f.http).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity])("makes no requests after an exhausted/invalid deadline: %s", async deadline => {
    const f = fixture();
    await expect(f.service.search(userA, request, deadline)).rejects.toMatchObject({ status: 503 });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("rejects schema drift rather than allowing the provider to silently ignore remote", async () => {
    const changed = structuredClone(action);
    changed.params.find(param => param.name === "workplace")!.allowed_values = [{ value: "onsite" }];
    const f = fixture({ action: changed });
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 503 });
    expect(f.paid()).toEqual([]);
  });
  it.each([
    { ...engine, engine: "unrelated-api" }, { ...engine, base_path: "https://evil.example" },
    { ...engine, actions: [] },
  ])("never executes an unverified engine/action/endpoint %#", async changed => {
    const f = fixture({ engine: changed });
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 503 });
    expect(f.paid()).toEqual([]);
  });
  it.each([
    { ...action, action: "applications/submit" },
    { ...action, required_params: ["keywords", "new_required_field"] },
    { ...action, required_params: ["keywords", "__proto__"] },
    { ...action, params: [...action.params, { name: "new_required_field", type: "string", required: true }] },
    { ...action, params: [...action.params, action.params[0]] },
    { ...action, params: action.params.filter(param => param.name !== "include_detail") },
  ])("fails closed on action schema changes before a paid request %#", async changed => {
    const f = fixture({ action: changed });
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 503 });
    expect(f.paid()).toEqual([]);
  });
  it.each([
    { brokenMcpId: true }, { sse: true, duplicateMcpId: true }, { mcpIsError: true },
  ])("rejects invalid, ambiguous, or failed MCP messages %#", async options => {
    const f = fixture(options);
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 503 });
    expect(f.paid()).toEqual([]);
  });
  it.each([401, 403, 429, 500])("sanitizes provider status %s without retrying", async status => {
    const f = fixture({ restStatus: status, result: { error: `${key} PRIVATE PROVIDER DETAIL` } });
    try { await f.service.search(userA, request); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toMatchObject({ status: 503 });
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain("PRIVATE PROVIDER");
    }
    expect(f.paid()).toHaveLength(1);
  });
  it.each([
    { ok: false, data: { jobs: [job] } }, { ok: true, data: { jobs: null } },
    { ok: true, data: { jobs: [job] }, error: { message: "failure" } },
    { ok: true, data: { jobs: Array(4).fill(job) } },
  ])("rejects malformed, failed, or unbounded provider envelopes %#", async result => {
    const f = fixture({ result });
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 503 });
    expect(f.paid()).toHaveLength(1);
  });
  it("rejects oversized responses without exposing their body", async () => {
    await expect(fixture({ oversized: true }).service.search(userA, request)).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    "http://www.linkedin.com/jobs/view/90001", "https://www.linkedin.com.evil.example/jobs/view/90001",
    "https://user:pass@www.linkedin.com/jobs/view/90001", "https://127.0.0.1/jobs/view/90001",
    "https://www.linkedin.com:444/jobs/view/90001", "https://www.linkedin.com/in/person",
    "javascript:alert(1)",
  ])("drops a malformed/unsafe posting URL without following it: %s", async url => {
    const result = await fixture({ jobs: [{ ...job, job_url: url }] }).service.search(userA, request);
    expect(result.jobs).toEqual([]);
    expect(result.droppedRecords).toBe(1);
  });
  it("deduplicates by source ID and canonical URL while retaining valid rows", async () => {
    const result = await fixture({ jobs: [job, { ...job }, { ...job, job_id: "90002" }] }).service.search(userA, request);
    expect(result.jobs).toHaveLength(1);
    expect(result.droppedRecords).toBe(2);
  });
  it("keeps zero results distinct from provider unavailability", async () => {
    const result = await fixture({ jobs: [] }).service.search(userA, request);
    expect(result.jobs).toEqual([]);
    expect(result.droppedRecords).toBe(0);
    expect(result.matching).toBe("not_run");
  });
  it("drops a provider row that echoes the runtime key, even in an otherwise valid response", async () => {
    const result = await fixture({ jobs: [{ ...job, description_text: `Untrusted response ${key}` }] }).service.search(userA, request);
    expect(result.jobs).toEqual([]);
    expect(result.droppedRecords).toBe(1);
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("rechecks server enablement after discovery and before a paid request", async () => {
    const f = fixture();
    const original = f.http.getMockImplementation()!;
    f.http.mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      f.env.REEFAPI_RESEARCH_ENABLED = "0";
      return response;
    });
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 503 });
    expect(f.paid()).toEqual([]);
  });
  it("does not cache or share one owner's search results with another", async () => {
    const f = fixture();
    await f.service.search(userA, request);
    await f.service.search(userB, { ...request, keywords: "Different literal search" });
    expect(f.paid()).toHaveLength(2);
    expect(f.paid()[1]!.payload.keywords).toBe("Different literal search");
    expect(JSON.stringify(f.paid().map(call => call.payload))).not.toContain(userA);
    expect(JSON.stringify(f.paid().map(call => call.payload))).not.toContain(userB);
  });
  it("applies a beta duplicate-search cooldown per exact account", async () => {
    const f = fixture();
    await f.service.search(userA, request);
    await expect(f.service.search(userA, request)).rejects.toMatchObject({ status: 429 });
    expect(f.paid()).toHaveLength(1);
    f.advance(60_000);
    await f.service.search(userA, request);
    expect(f.paid()).toHaveLength(2);
  });
  it("rejects a concurrent duplicate before a second paid request", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.service.search(userA, request), f.service.search(userA, request)]);
    expect(results.map(item => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { status: 429 } });
    expect(f.paid()).toHaveLength(1);
  });
});
