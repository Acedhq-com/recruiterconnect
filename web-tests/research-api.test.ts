import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCareerRoutes } from "../server/career-routes.js";
import type { AccountRecords, IAccountService, VerifiedSession } from "../server/account-service.js";
import type { ICareerStorage } from "../server/career-service.js";
import type { IResearchService } from "../server/research-service.js";
import type { CareerFeed } from "../shared/career-schema.js";
import type { ResearchResult } from "../shared/research-schema.js";

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const path = "/api/career/research/search";
const query = { keywords: "Operations Analyst", location: "United States", workplace: "remote" };
const verified: VerifiedSession = { user: { id: userA, email: "synthetic@example.com" },
  tokens: { accessToken: "synthetic-jwt", refreshToken: "synthetic-refresh", expiresIn: 3600 } };
const result: ResearchResult = {
  source: "linkedin", provider: "reefapi", checkedAt: "2026-11-07T12:00:00Z", jobs: [],
  droppedRecords: 0, hasMore: false, matching: "not_run", verification: "employer_and_resume_review_required",
};
let accounts: IAccountService;
let storage: ICareerStorage;
let research: IResearchService;
function app() {
  const app = express(); app.use(express.json({ limit: "12kb" }));
  const feed = { get: vi.fn<() => Promise<CareerFeed>>() };
  registerCareerRoutes(app, accounts, storage, feed, research);
  return app;
}
function post(body: Record<string, unknown> = query) {
  return request(app()).post(path).set("Host", "findworkprivately.com")
    .set("Origin", "https://findworkprivately.com").set("X-Account-Id", userA).send(body);
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", "0");
  vi.stubEnv("APP_ORIGIN", "https://findworkprivately.com");
  accounts = {
    enabled: vi.fn(() => true), start: vi.fn(), verify: vi.fn(), resolve: vi.fn(async () => verified),
    logout: vi.fn(), records: vi.fn(async (): Promise<AccountRecords> => ({
      account: { user_id: userA, account_kind: "candidate", display_name: "Synthetic Account",
        status: "active", deletion_requested_at: null }, profile: null, privacy: null, recruiter: null, discovery: null,
    })), onboard: vi.fn(), saveProfile: vi.fn(), saveEmployer: vi.fn(), addBlock: vi.fn(), removeBlock: vi.fn(), saveRecruiterFirm: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), submitRecruiter: vi.fn(), setDiscovery: vi.fn(), search: vi.fn(), requestDeletion: vi.fn(), cancelDeletion: vi.fn(),
  };
  storage = { read: vi.fn(), saveBackground: vi.fn(), saveWorkflow: vi.fn(), saveDocument: vi.fn(), removeDocument: vi.fn() };
  research = { allowed: vi.fn(() => true), search: vi.fn(async () => result) };
});
afterEach(() => vi.unstubAllEnvs());

describe("owner-bound candidate research API", () => {
  it("reports only the current candidate's enablement without spending provider credits", async () => {
    const response = await request(app()).get("/api/career/research/status").set("X-Account-Id", userA);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true, source: "linkedin", provider: "reefapi" });
    expect(response.headers["cache-control"]).toContain("private, no-store");
    expect(research.allowed).toHaveBeenCalledWith(userA);
    expect(research.search).not.toHaveBeenCalled();
  });
  it("honestly reports disabled research for a verified but non-allowlisted candidate", async () => {
    vi.mocked(research.allowed).mockReturnValue(false);
    const response = await request(app()).get("/api/career/research/status").set("X-Account-Id", userA);
    expect(response.body.enabled).toBe(false);
    expect(research.search).not.toHaveBeenCalled();
  });
  it("does not reveal research enablement to a stale foreign identity", async () => {
    const response = await request(app()).get("/api/career/research/status").set("X-Account-Id", userB);
    expect(response.status).toBe(409);
    expect(research.allowed).not.toHaveBeenCalled();
  });
  it("makes a private, bounded request for only the verified candidate identity", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("private, no-store");
    expect(response.headers.vary).toBe("Cookie");
    expect(research.search).toHaveBeenCalledWith(userA, { ...query, maxResults: 20, datePosted: "week" }, expect.any(Number));
    expect(vi.mocked(research.search).mock.calls[0]![2]).toBeLessThanOrEqual(27_000);
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.saveWorkflow).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("synthetic-jwt");
  });
  it("preserves the verified email launch gate before provider work", async () => {
    vi.mocked(accounts.enabled).mockReturnValue(false);
    expect((await post()).status).toBe(503);
    expect(accounts.resolve).not.toHaveBeenCalled();
    expect(research.search).not.toHaveBeenCalled();
  });
  it("rejects anonymous/revoked sessions before checking provider enablement", async () => {
    vi.mocked(accounts.resolve).mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(research.allowed).not.toHaveBeenCalled();
    expect(research.search).not.toHaveBeenCalled();
  });
  it.each(["", userB])("rejects missing or stale browser owner %s", async owner => {
    expect((await post().set("X-Account-Id", owner)).status).toBe(409);
    expect(research.search).not.toHaveBeenCalled();
  });
  it.each(["recruiter", "suspended", "deletion_requested", "unonboarded"])("does not grant research through %s authority", async mode => {
    vi.mocked(accounts.records).mockResolvedValue({
      account: mode === "unonboarded" ? null : { user_id: userA, display_name: "Synthetic",
        account_kind: mode === "recruiter" ? "recruiter" : "candidate",
        status: mode === "suspended" || mode === "deletion_requested" ? mode : "active",
        deletion_requested_at: null }, profile: null, privacy: null, recruiter: null, discovery: null,
    });
    expect((await post()).status).toBe(403);
    expect(research.search).not.toHaveBeenCalled();
  });
  it("rejects an overlapping or foreign company/account record", async () => {
    const records = await accounts.records(verified);
    vi.mocked(accounts.records).mockResolvedValue({ ...records, account: { ...records.account!, user_id: userB } });
    expect((await post()).status).toBe(503);
    expect(research.search).not.toHaveBeenCalled();
  });
  it("requires separate exact-account provider enablement", async () => {
    vi.mocked(research.allowed).mockReturnValue(false);
    expect((await post()).status).toBe(403);
    expect(research.search).not.toHaveBeenCalled();
  });
  it.each(["https://evil.example", "null", "https://recruiterconnect-three.vercel.app"])("rejects unsupported origin %s", async origin => {
    expect((await post().set("Origin", origin)).status).toBe(403);
    expect(accounts.resolve).not.toHaveBeenCalled();
    expect(research.search).not.toHaveBeenCalled();
  });
  it("requires JSON for a potentially metered action", async () => {
    const response = await request(app()).post(path).set("Host", "findworkprivately.com")
      .set("Origin", "https://findworkprivately.com").type("form").send("keywords=analyst");
    expect(response.status).toBe(415);
    expect(research.search).not.toHaveBeenCalled();
  });
  it.each(["user_id", "company_id", "owner", "engine", "action", "endpoint", "apiKey", "resume", "admin"])("rejects caller-selected %s before provider calls", async key => {
    expect((await post({ ...query, [key]: "not-authority" })).status).toBe(400);
    expect(research.search).not.toHaveBeenCalled();
  });
  it("returns unavailable rather than exposing provider secrets or claiming closure", async () => {
    vi.mocked(research.search).mockRejectedValue(new Error("PRIVATE API KEY PROVIDER CONTENT"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE API KEY");
    expect(storage.saveWorkflow).not.toHaveBeenCalled();
  });
  it("does not expose a paid GET search route", async () => {
    expect((await request(app()).get(path)).status).toBe(404);
    expect(research.search).not.toHaveBeenCalled();
  });
});
