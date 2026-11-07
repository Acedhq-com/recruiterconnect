import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseCareerStorage } from "../server/career-service.js";
import { emptyBackground, jobSnapshot } from "../shared/career-schema.js";
import type { VerifiedSession } from "../server/account-service.js";
import { testJob } from "./career-fixtures.js";

const uid = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const session: VerifiedSession = { user: { id: uid, email: "qa@example.com" },
  tokens: { accessToken: "only-user-jwt", refreshToken: "never-forwarded-refresh", expiresIn: 3600 } };
let calls: { url: string; method: string; headers: Headers; body: Record<string, unknown> | null }[];
let rows: Record<string, unknown[]>;
let providerError: string | null;
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://qa.example.test");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "fake-low-privilege-test-key");
  calls = []; providerError = null;
  rows = {
    career_backgrounds: [{ user_id: uid, content: emptyBackground, version: 1 }],
    career_workflows: [{ user_id: uid, snapshot: jobSnapshot(testJob), stage: "Saved", notes: '=1+1\n"literal"',
      next_action: "", applied_date: null, follow_up_date: null, version: 1 }],
    career_documents: [{ user_id: uid, id: uid, kind: "resume", title: "Draft", body: '=1+1\n"literal"',
      target_role: "", target_company: "", source_job_id: null, version: 1 }],
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (providerError) return new Response(JSON.stringify({ code: providerError, message: "PRIVATE PROVIDER DETAIL" }),
      { status: 400, headers: { "Content-Type": "application/json" } });
    const table = new URL(url).pathname.split("/").at(-1)!;
    return new Response(JSON.stringify(url.includes("/rpc/") ? null : rows[table] ?? []),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("real PostgREST SDK career storage boundary", () => {
  it("uses only the verified access JWT and filters every read by its owner", async () => {
    const result = await new SupabaseCareerStorage().read(session);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer only-user-jwt");
      expect(call.headers.get("apikey")).toBe("fake-low-privilege-test-key");
      expect(new URL(call.url).searchParams.get("user_id")).toBe(`eq.${uid}`);
      expect(JSON.stringify(call)).not.toContain("never-forwarded-refresh");
    }
    expect(result.jobs[0]?.appliedDate).toBe("");
    expect(result.documents[0]?.body).toBe('=1+1\n"literal"');
    expect(JSON.stringify(result)).not.toContain("user_id");
  });
  it.each(["career_backgrounds", "career_workflows", "career_documents"])("fails closed if %s returns a foreign owner", async table => {
    rows[table] = [{ ...(rows[table]![0] as object), user_id: foreign }];
    await expect(new SupabaseCareerStorage().read(session)).rejects.toMatchObject({ status: 503 });
  });
  it("accepts an empty account without substituting anyone's data", async () => {
    rows = {};
    expect(await new SupabaseCareerStorage().read(session)).toEqual({ background: null, jobs: [], documents: [] });
  });
  it("passes no caller-controlled user ID to a background RPC", async () => {
    await new SupabaseCareerStorage().saveBackground(session, emptyBackground, 0);
    expect(calls[0]?.body).toEqual({ p_content: emptyBackground, p_expected_version: 0 });
  });
  it("preserves explicit blanks as database null dates and literal notes", async () => {
    await new SupabaseCareerStorage().saveWorkflow(session, { job: jobSnapshot(testJob), stage: "Saved",
      notes: "=1+1\nline two", nextAction: "", appliedDate: "", followUpDate: "", expectedVersion: 1 });
    expect(calls[0]?.body).toMatchObject({ p_applied_date: null, p_follow_up_date: null, p_notes: "=1+1\nline two", p_expected_version: 1 });
    expect(calls[0]?.body).not.toHaveProperty("p_user_id");
  });
  it("binds document save and removal to IDs and optimistic versions, not an owner parameter", async () => {
    const storage = new SupabaseCareerStorage();
    await storage.saveDocument(session, { id: uid, kind: "resume", title: "Draft", body: "Facts", targetRole: "",
      targetCompany: "", sourceJobId: null, expectedVersion: 0 });
    await storage.removeDocument(session, uid, 1);
    expect(calls[0]?.body).toMatchObject({ p_id: uid, p_expected_version: 0, p_source_job_id: null });
    expect(calls[1]?.body).toEqual({ p_id: uid, p_expected_version: 1 });
  });
  it.each([["42501", 403], ["40001", 409], ["22023", 400], ["22007", 400], ["54000", 429], ["XX000", 503]])(
    "maps provider code %s to a sanitized %s", async (code, status) => {
      providerError = String(code);
      await expect(new SupabaseCareerStorage().saveBackground(session, emptyBackground, 0))
        .rejects.toMatchObject({ status });
      await expect(new SupabaseCareerStorage().read(session)).rejects.not.toHaveProperty("message", "PRIVATE PROVIDER DETAIL");
    });
});
