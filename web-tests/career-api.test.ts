import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { registerCareerRoutes } from "../server/career-routes.js";
import { registerAccountRoutes } from "../server/account-routes.js";
import { AccountError } from "../server/account-service.js";
import type { AccountRecords, IAccountService, VerifiedSession } from "../server/account-service.js";
import type { ICareerStorage } from "../server/career-service.js";
import { emptyBackground, emptyWorkspace, jobSnapshot } from "../shared/career-schema.js";
import type { CareerFeed } from "../shared/career-schema.js";
import { testJob } from "./career-fixtures.js";
import { readFileSync } from "node:fs";
const deployment = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
  functions: { "api/index.ts": { maxDuration: number } };
  rewrites: { source: string; destination: string }[];
};

const uid = "11111111-1111-4111-8111-111111111111";
const session: VerifiedSession = { user: { id: uid, email: "qa@example.com" },
  tokens: { accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 3600 } };
let accounts: IAccountService;
let storage: ICareerStorage;
let feed: { get: Mock<() => Promise<CareerFeed>> };
const feedResult: CareerFeed = { jobs: [testJob], sources: [], status: "complete",
  checkedAt: testJob.checkedAt, expiresAt: testJob.checkedAt, total: 1,
  truncated: false, coverage: "Synthetic test fixture only", matching: "not_run", cached: false };
function app() {
  const result = express(); result.use(express.json({ limit: "224kb" }));
  registerAccountRoutes(result, accounts);
  registerCareerRoutes(result, accounts, storage, feed);
  return result;
}
function post(path: string, body: Record<string, unknown>) {
  return request(app()).post(path).set("Host", "findworkprivately.com")
    .set("Origin", "https://findworkprivately.com").set("X-Account-Id", uid)
    .set("Cookie", "fwp-access=test-access; fwp-refresh=test-refresh").send(body);
}
const workflow = { job: jobSnapshot(testJob), stage: "Saved", notes: "", nextAction: "",
  appliedDate: "", followUpDate: "", expectedVersion: 0 };
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", "0");
  vi.stubEnv("APP_ORIGIN", "https://findworkprivately.com");
  accounts = { enabled: vi.fn(() => true), start: vi.fn(), verify: vi.fn(), resolve: vi.fn(async () => session),
    logout: vi.fn(), records: vi.fn(async (): Promise<AccountRecords> => ({ account: { user_id: uid, account_kind: "candidate",
      display_name: "QA Person", status: "active", deletion_requested_at: null }, profile: null })),
    onboard: vi.fn(), saveProfile: vi.fn(), requestDeletion: vi.fn(), cancelDeletion: vi.fn() };
  storage = { read: vi.fn(async () => emptyWorkspace()), saveBackground: vi.fn(), saveWorkflow: vi.fn(),
    saveDocument: vi.fn(), removeDocument: vi.fn() };
  feed = { get: vi.fn(async () => feedResult) };
});
afterEach(() => vi.unstubAllEnvs());

describe("public employer feed boundary", () => {
  it("allows the bounded employer check to finish within the existing project's runtime cap", () => {
    expect(deployment.functions["api/index.ts"].maxDuration).toBeGreaterThanOrEqual(20);
  });
  it("routes the public feed before a wildcard can inject a path query parameter", () => {
    expect(deployment.rewrites[0]).toEqual({ source: "/api/jobs", destination: "/api" });
    expect(deployment.rewrites[1]).toEqual({ source: "/api/:path*", destination: "/api" });
  });
  it("reads the public-only adapter without account or storage access", async () => {
    const response = await request(app()).get("/api/jobs");
    expect(response.status).toBe(200);
    expect(response.body.jobs[0].id).toBe(testJob.id);
    expect(response.headers["cache-control"]).toContain("s-maxage=300");
    expect(accounts.resolve).not.toHaveBeenCalled(); expect(storage.read).not.toHaveBeenCalled();
  });
  it("rejects caller-selected feed URLs before any network work", async () => {
    const response = await request(app()).get("/api/jobs?source=http://127.0.0.1");
    expect(response.status).toBe(400); expect(feed.get).not.toHaveBeenCalled();
  });
  it("still rejects caller-provided routing parameters instead of weakening the feed boundary", async () => {
    const response = await request(app()).get("/api/jobs?path=jobs");
    expect(response.status).toBe(400); expect(feed.get).not.toHaveBeenCalled();
  });
  it("does not cache all-source failure as live results", async () => {
    feed.get.mockResolvedValue({ ...feedResult, jobs: [], status: "unavailable" });
    const response = await request(app()).get("/api/jobs");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.jobs).toEqual([]);
  });
  it("sanitizes provider failures without a fictional fallback", async () => {
    feed.get.mockRejectedValue(new Error("PRIVATE PROVIDER DETAIL"));
    const response = await request(app()).get("/api/jobs");
    expect(response.status).toBe(503); expect(JSON.stringify(response.body)).not.toContain("PRIVATE PROVIDER");
  });
});
describe("private career API authorization and consistency", () => {
  it.each([
    ["/api/account/onboard", { kind: "candidate", displayName: "QA Candidate", acknowledgePrivateBeta: true }],
    ["/api/account/profile", { displayName: "QA Candidate", headline: "Analyst", skills: ["Excel"], workPreference: "Remote", expectedVersion: 1 }],
    ["/api/account/deletion-request", { confirmation: "DELETE" }],
    ["/api/account/cancel-deletion", {}],
  ] as [string, Record<string, unknown>][])("rejects a stale account identity on %s too", async (path, input) => {
    expect((await post(path, input).set("X-Account-Id", "22222222-2222-4222-8222-222222222222")).status).toBe(409);
    expect(accounts.onboard).not.toHaveBeenCalled();
    expect(accounts.saveProfile).not.toHaveBeenCalled();
    expect(accounts.requestDeletion).not.toHaveBeenCalled();
    expect(accounts.cancelDeletion).not.toHaveBeenCalled();
  });
  it("returns only an authenticated candidate's workspace with private cache headers", async () => {
    const response = await request(app()).get("/api/career/workspace").set("X-Account-Id", uid);
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("private, no-store");
    expect(storage.read).toHaveBeenCalledWith(session);
    expect(JSON.stringify(response.body)).not.toContain("test-access");
  });
  it("keeps account saving disabled without verified email configuration", async () => {
    vi.mocked(accounts.enabled).mockReturnValue(false);
    expect((await post("/api/career/workflow", workflow)).status).toBe(503);
    expect(accounts.resolve).not.toHaveBeenCalled(); expect(storage.saveWorkflow).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated and revoked sessions", async () => {
    vi.mocked(accounts.resolve).mockResolvedValue(null);
    expect((await post("/api/career/workflow", workflow)).status).toBe(401);
    expect(storage.saveWorkflow).not.toHaveBeenCalled();
  });
  it.each(["", "22222222-2222-4222-8222-222222222222"])("rejects missing or stale browser account identity %s", id => {
    return request(app()).get("/api/career/workspace").set("X-Account-Id", id).then(response => {
      expect(response.status).toBe(409); expect(storage.read).not.toHaveBeenCalled();
    });
  });
  it.each(["recruiter", "suspended", "deletion_requested", "unonboarded"])("does not grant workspace authority through %s", value => {
    vi.mocked(accounts.records).mockResolvedValue({ account: value === "unonboarded" ? null : {
      user_id: uid, account_kind: value === "recruiter" ? "recruiter" : "candidate",
      display_name: "QA", status: value === "suspended" || value === "deletion_requested" ? value : "active",
      deletion_requested_at: null,
    }, profile: null });
    return post("/api/career/workflow", workflow).then(response => {
      expect(response.status).toBe(403); expect(storage.saveWorkflow).not.toHaveBeenCalled();
    });
  });
  it("fails closed on a mismatched owner returned by storage", async () => {
    vi.mocked(accounts.records).mockResolvedValue({ account: {
      user_id: "22222222-2222-4222-8222-222222222222", account_kind: "candidate",
      display_name: "Foreign", status: "active", deletion_requested_at: null,
    }, profile: null });
    expect((await post("/api/career/workflow", workflow)).status).toBe(503);
    expect(storage.saveWorkflow).not.toHaveBeenCalled();
  });
  it.each(["https://evil.example", "null", "https://recruiterconnect-three.vercel.app"])("rejects unsupported write origin %s", origin => {
    return post("/api/career/workflow", workflow).set("Origin", origin).then(response => {
      expect(response.status).toBe(403); expect(storage.saveWorkflow).not.toHaveBeenCalled();
    });
  });
  it("requires JSON before private writes", async () => {
    const response = await request(app()).post("/api/career/workflow").set("Origin", "https://findworkprivately.com")
      .set("Host", "findworkprivately.com").type("form").send("notes=hello");
    expect(response.status).toBe(415); expect(storage.saveWorkflow).not.toHaveBeenCalled();
  });
  it.each(["user_id", "company_id", "admin", "discovery_active"])("rejects forged %s in writes", async key => {
    expect((await post("/api/career/workflow", { ...workflow, [key]: "foreign" })).status).toBe(400);
    expect(storage.saveWorkflow).not.toHaveBeenCalled();
  });
  it("passes a validated owner-bound job save and preserves explicit blanks", async () => {
    const response = await post("/api/career/workflow", workflow);
    expect(response.status).toBe(200);
    expect(storage.saveWorkflow).toHaveBeenCalledWith(session, workflow);
  });
  it("saves background without inferring public visibility", async () => {
    expect((await post("/api/career/background", { content: emptyBackground, expectedVersion: 0 })).status).toBe(200);
    expect(storage.saveBackground).toHaveBeenCalledWith(session, emptyBackground, 0);
  });
  it("returns conflict without a false success or follow-up read", async () => {
    vi.mocked(storage.saveWorkflow).mockRejectedValue(new AccountError(409, "Reload latest version"));
    expect((await post("/api/career/workflow", workflow)).status).toBe(409);
    expect(storage.read).not.toHaveBeenCalled();
  });
  it("does not reveal storage secrets", async () => {
    vi.mocked(storage.saveWorkflow).mockRejectedValue(new Error("PRIVATE DATABASE DETAIL"));
    const response = await post("/api/career/workflow", workflow);
    expect(response.status).toBe(503); expect(JSON.stringify(response.body)).not.toContain("PRIVATE DATABASE");
  });
  it("validates a draft and binds removal to its version", async () => {
    const document = { id: uid, kind: "resume", title: "Draft", body: "Actual experience",
      targetRole: "Analyst", targetCompany: "", sourceJobId: null, expectedVersion: 0 };
    expect((await post("/api/career/document", document)).status).toBe(200);
    expect(storage.saveDocument).toHaveBeenCalledWith(session, document);
    expect((await post("/api/career/document/remove", { id: uid, expectedVersion: 1 })).status).toBe(200);
    expect(storage.removeDocument).toHaveBeenCalledWith(session, uid, 1);
    expect((await post("/api/career/document/remove", { id: uid, expectedVersion: 0 })).status).toBe(400);
  });
});
