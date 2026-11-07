import express from "express";
import request from "supertest";
import { afterEach, expect, test, vi } from "vitest";
import { registerAccountRoutes } from "../server/account-routes.js";
import type { IAccountService, VerifiedSession } from "../server/account-service.js";
import { readFileSync } from "node:fs";

// These failed at the audited SHA and are mandatory remediation regressions.
afterEach(() => vi.unstubAllEnvs());
const session: VerifiedSession = {
  user: { id: "11111111-1111-4111-8111-111111111111", email: "audit@example.com" },
  tokens: { accessToken: "audit-rotated-access", refreshToken: "audit-refresh", expiresIn: 3600 },
};

test("RC-02: refresh-only logout must not claim server revocation without doing it", async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", "0");
  vi.stubEnv("APP_ORIGIN", "https://findworkprivately.com");
  const resolve = vi.fn(async () => session);
  const logout = vi.fn(async () => true);
  const service: IAccountService = {
    enabled: () => true, start: vi.fn(), verify: vi.fn(), resolve, logout,
    records: vi.fn(), onboard: vi.fn(), saveProfile: vi.fn(), saveEmployer: vi.fn(), addBlock: vi.fn(), removeBlock: vi.fn(),
    saveRecruiterFirm: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), submitRecruiter: vi.fn(), setDiscovery: vi.fn(), search: vi.fn(), requestDeletion: vi.fn(), cancelDeletion: vi.fn(),
  };
  const app = express(); app.use(express.json()); registerAccountRoutes(app, service);
  const result = await request(app).post("/api/auth/logout")
    .set("Host", "findworkprivately.com").set("Origin", "https://findworkprivately.com")
    .set("Cookie", "fwp-refresh=audit-refresh").send({});
  expect(result.status).toBe(200);
  expect(result.headers["set-cookie"]).toEqual(expect.arrayContaining([
    expect.stringContaining("Max-Age=0"),
  ]));
  // A fix may either revoke the refresh session or report revocation incomplete.
  const revoked = logout.mock.calls.length > 0;
  expect(result.body.revocationComplete === true && !revoked).toBe(false);
});

test("RC-06: production pages explicitly prohibit third-party framing", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const headers = config.headers.flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers);
  const csp = headers.find((header: { key: string }) => header.key.toLowerCase() === "content-security-policy");
  const xfo = headers.find((header: { key: string }) => header.key.toLowerCase() === "x-frame-options");
  expect(Boolean(csp?.value.includes("frame-ancestors 'none'") || xfo?.value.toUpperCase() === "DENY")).toBe(true);
});

test.each([
  { name: "refresh only", access: false, refresh: true, resolved: true, provider: true, expected: true },
  { name: "unresolved refresh", access: false, refresh: true, resolved: false, provider: true, expected: false },
  { name: "refresh provider failure", access: false, refresh: true, resolved: true, provider: false, expected: false },
  { name: "access only", access: true, refresh: false, resolved: false, provider: true, expected: true },
  { name: "no cookies", access: false, refresh: false, resolved: false, provider: true, expected: true },
])("RC-02: $name has truthful revocation and clears cookies", async entry => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", "0");
  vi.stubEnv("APP_ORIGIN", "https://findworkprivately.com");
  const resolve = vi.fn(async () => entry.resolved ? session : null);
  const logout = vi.fn(async () => entry.provider);
  const service: IAccountService = {
    enabled: () => true, start: vi.fn(), verify: vi.fn(), resolve, logout,
    records: vi.fn(), onboard: vi.fn(), saveProfile: vi.fn(), saveEmployer: vi.fn(), addBlock: vi.fn(), removeBlock: vi.fn(),
    saveRecruiterFirm: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), submitRecruiter: vi.fn(), setDiscovery: vi.fn(), search: vi.fn(), requestDeletion: vi.fn(), cancelDeletion: vi.fn(),
  };
  const app = express(); app.use(express.json()); registerAccountRoutes(app, service);
  const cookies = [entry.access ? "fwp-access=audit-access" : "",
    entry.refresh ? "fwp-refresh=audit-refresh" : ""].filter(Boolean).join("; ");
  let action = request(app).post("/api/auth/logout").set("Host", "findworkprivately.com")
    .set("Origin", "https://findworkprivately.com");
  if (cookies) action = action.set("Cookie", cookies);
  const result = await action.send({});
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ signedOut: true, revocationComplete: entry.expected });
  const setCookies = result.headers["set-cookie"] as unknown as string[];
  expect(setCookies).toHaveLength(2);
  expect(setCookies.every(value => value.includes("Max-Age=0"))).toBe(true);
  expect(resolve).toHaveBeenCalledTimes(!entry.access && entry.refresh ? 1 : 0);
  if (!entry.access && entry.refresh) expect(resolve).toHaveBeenCalledWith(undefined, "audit-refresh");
  expect(logout).toHaveBeenCalledTimes(entry.access || entry.resolved ? 1 : 0);
});

test("RC-02: refresh-resolution exception cannot prevent browser logout", async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", "0");
  vi.stubEnv("APP_ORIGIN", "https://findworkprivately.com");
  const service: IAccountService = {
    enabled: () => true, start: vi.fn(), verify: vi.fn(),
    resolve: vi.fn(async () => { throw new Error("synthetic provider failure"); }),
    logout: vi.fn(), records: vi.fn(), onboard: vi.fn(), saveProfile: vi.fn(), saveEmployer: vi.fn(), addBlock: vi.fn(), removeBlock: vi.fn(),
    saveRecruiterFirm: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), submitRecruiter: vi.fn(), setDiscovery: vi.fn(), search: vi.fn(), requestDeletion: vi.fn(), cancelDeletion: vi.fn(),
  };
  const app = express(); app.use(express.json()); registerAccountRoutes(app, service);
  const result = await request(app).post("/api/auth/logout")
    .set("Host", "findworkprivately.com").set("Origin", "https://findworkprivately.com")
    .set("Cookie", "fwp-refresh=audit-refresh").send({});
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ signedOut: true, revocationComplete: false });
  expect(result.headers["set-cookie"]).toHaveLength(2);
});

test("RC-06: Express responses prohibit framing as well as the static manifest", async () => {
  const { app } = await import("../server/app.js");
  const result = await request(app).get("/api/auth/session");
  expect(result.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(result.headers["x-frame-options"]).toBe("DENY");
  expect(result.headers["x-content-type-options"]).toBe("nosniff");
});
