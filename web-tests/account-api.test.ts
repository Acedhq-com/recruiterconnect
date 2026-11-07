import express from "express";
import request from "supertest";
import { afterEach, expect, test, vi } from "vitest";
import { registerAccountRoutes } from "../server/account-routes.js";
import { AccountError } from "../server/account-service.js";
import type { IAccountService, VerifiedSession } from "../server/account-service.js";
import type { PrivateAccount, PrivateProfile } from "../shared/account-schema.js";

afterEach(() => vi.unstubAllEnvs());
const userId = "f4706aa9-4e3b-46a6-843f-0f7478a21c0e";
const session: VerifiedSession = {
  user: { id: userId, email: "synthetic@example.com" },
  tokens: { accessToken: "PRIVATE_ACCESS_TOKEN", refreshToken: "PRIVATE_REFRESH_TOKEN", expiresIn: 3600 },
};
const account: PrivateAccount = { user_id: userId, account_kind: "candidate",
  display_name: "Synthetic Account", status: "active", deletion_requested_at: null };
const profile: PrivateProfile = { headline: "Private draft", skills: ["Analysis"], work_preference: "Remote",
  discovery_active: false, version: 1 };
const onboarding = { kind: "candidate", displayName: "Synthetic Account", acknowledgePrivateBeta: true };
const save = { displayName: "Synthetic Account", headline: "Private draft", skills: ["Analysis"],
  workPreference: "Remote", expectedVersion: 1 };
function setup(overrides: Partial<IAccountService> = {}) {
  const service: IAccountService = {
    enabled: () => true, start: vi.fn(async () => {}),
    verify: vi.fn(async () => session), resolve: vi.fn(async () => session),
    logout: vi.fn(async () => true),
    records: vi.fn(async () => ({ account, profile })),
    onboard: vi.fn(async () => {}), saveProfile: vi.fn(async () => {}),
    requestDeletion: vi.fn(async () => {}), cancelDeletion: vi.fn(async () => {}),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, service);
  return { app, service };
}
function write(app: express.Express, path: string, body: Record<string, unknown>) {
  return request(app).post(path).set("host", "findworkprivately.com")
    .set("origin", "https://findworkprivately.com").send(body);
}
test("unconfigured auth reports disabled without contacting a provider", async () => {
  const { app, service } = setup({ enabled: () => false });
  const result = await request(app).get("/api/auth/session");
  expect(result.body).toEqual({ user: null, account: null, profile: null,
    authEnabled: false, appOrigin: "https://findworkprivately.com", method: "email-code" });
  expect(service.resolve).not.toHaveBeenCalled();
  expect(result.headers["cache-control"]).toContain("private, no-store");
});
test("disabled signup does not send email", async () => {
  const { app, service } = setup({ enabled: () => false });
  expect((await write(app, "/api/auth/start", { email: "person@example.com" })).status).toBe(503);
  expect(service.start).not.toHaveBeenCalled();
});
test("normalizes email without claiming a user exists", async () => {
  const { app, service } = setup();
  const result = await write(app, "/api/auth/start", { email: " Person@Example.com " });
  expect(result.status).toBe(202);
  expect(result.body.accepted).toBe(true);
  expect(service.start).toHaveBeenCalledWith("person@example.com", undefined);
});
test.each([{ email: "bad" }, { email: "a@example.com", role: "admin" },
  { email: "a@example.com", user_id: userId }, { email: "a@example.com", verified: true }])(
  "caller cannot assert account authority %j", async body => {
    const { app, service } = setup();
    expect((await write(app, "/api/auth/start", body)).status).toBe(400);
    expect(service.start).not.toHaveBeenCalled();
  });
test.each(["https://evil.example", "null", "https://findworkprivately.com.evil.example", "not-a-url"])(
  "rejects cross-origin account writes from %s", async origin => {
    const { app, service } = setup();
    const result = await request(app).post("/api/auth/start").set("host", "findworkprivately.com")
      .set("origin", origin).send({ email: "a@example.com" });
    expect(result.status).toBe(403);
    expect(service.start).not.toHaveBeenCalled();
  });
test("requires origin and JSON for browser account writes", async () => {
  const { app } = setup();
  expect((await request(app).post("/api/auth/start").send({ email: "a@example.com" })).status).toBe(403);
  expect((await request(app).post("/api/auth/start").type("form").send("email=a@example.com")).status).toBe(415);
});
test("legacy host cannot start a canonical-domain cookie flow", async () => {
  const { app } = setup();
  const result = await request(app).post("/api/auth/start").set("host", "recruiterconnect-three.vercel.app")
    .set("origin", "https://recruiterconnect-three.vercel.app").send({ email: "a@example.com" });
  expect(result.status).toBe(403);
});
test("verified tokens go only to HttpOnly cookies, never JSON", async () => {
  const { app } = setup();
  const result = await write(app, "/api/auth/verify", { email: "person@example.com", code: "123456" });
  expect(result.status).toBe(200);
  expect(result.body.user.id).toBe(userId);
  expect(JSON.stringify(result.body)).not.toContain("PRIVATE_");
  const cookies = result.headers["set-cookie"] as unknown as string[];
  expect(cookies).toHaveLength(2);
  for (const value of cookies) {
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Path=/");
    expect(value).not.toContain("Domain=");
  }
});
test("production cookies use host-only secure prefixes", async () => {
  vi.stubEnv("VERCEL", "1");
  const { app } = setup();
  const result = await write(app, "/api/auth/verify", { email: "person@example.com", code: "123456" });
  const cookies = result.headers["set-cookie"] as unknown as string[];
  expect(cookies[0]).toMatch(/^__Host-fwp-access=/);
  expect(cookies[1]).toMatch(/^__Host-fwp-refresh=/);
  expect(cookies.every(value => value.includes("; Secure"))).toBe(true);
});
test.each(["bad", "", "123", "12345678901", "12345x"])("invalid code %j never reaches the provider", async code => {
  const { app, service } = setup();
  expect((await write(app, "/api/auth/verify", { email: "a@example.com", code })).status).toBe(400);
  expect(service.verify).not.toHaveBeenCalled();
});
test("unknown provider exceptions do not leak diagnostics", async () => {
  const { app } = setup({ verify: async () => { throw new Error("SENSITIVE_PROVIDER_DETAIL"); } });
  const result = await write(app, "/api/auth/verify", { email: "a@example.com", code: "123456" });
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).not.toContain("SENSITIVE_PROVIDER_DETAIL");
  expect(result.headers["set-cookie"]).toBeUndefined();
});
test("missing or revoked session cannot onboard", async () => {
  const { app, service } = setup({ resolve: async () => null });
  expect((await write(app, "/api/account/onboard", onboarding)).status).toBe(401);
  expect(service.onboard).not.toHaveBeenCalled();
});
test("self-selected recruiter kind grants no token or verification field", async () => {
  const { app, service } = setup();
  const result = await write(app, "/api/account/onboard", { ...onboarding, kind: "recruiter" });
  expect(result.status).toBe(200);
  expect(service.onboard).toHaveBeenCalledWith(session, { ...onboarding, kind: "recruiter" });
  expect(result.body.verifiedRecruiter).toBeUndefined();
});
test.each([{ kind: "admin" }, { user_id: "another-user" }, { verified: true }, { status: "active" }])(
  "onboarding rejects extra grants or unknown roles %j", async patch => {
    const { app, service } = setup();
    expect((await write(app, "/api/account/onboard", { ...onboarding, ...patch })).status).toBe(400);
    expect(service.onboard).not.toHaveBeenCalled();
  });
test("private profile persistence uses the verified session, not an asserted user ID", async () => {
  const { app, service } = setup();
  expect((await write(app, "/api/account/profile", save)).status).toBe(200);
  expect(service.saveProfile).toHaveBeenCalledWith(session, save);
});
test.each([{ user_id: "another-user" }, { discovery_active: true }, { account_kind: "recruiter" },
  { expectedVersion: 0 }, { skills: Array.from({ length: 13 }, () => "skill") }])(
  "profile update rejects unsafe fields %j", async patch => {
    const { app, service } = setup();
    expect((await write(app, "/api/account/profile", { ...save, ...patch })).status).toBe(400);
    expect(service.saveProfile).not.toHaveBeenCalled();
  });
test("cross-account records fail closed before serialization", async () => {
  const { app } = setup({ records: async () => ({ account: { ...account, user_id: "wrong-owner" }, profile }) });
  const result = await request(app).get("/api/auth/session");
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).not.toContain("wrong-owner");
  expect(JSON.stringify(result.body)).not.toContain(profile.headline);
});
test("optimistic concurrency conflicts remain conflicts", async () => {
  const { app } = setup({ saveProfile: async () => { throw new AccountError(409, "Profile changed."); } });
  expect((await write(app, "/api/account/profile", save)).status).toBe(409);
});
test("transient auth failures do not clear valid cookies", async () => {
  const { app } = setup({ resolve: async () => { throw new AccountError(503, "Provider temporarily unavailable."); } });
  const result = await request(app).get("/api/auth/session").set("cookie", "fwp-access=valid; fwp-refresh=valid");
  expect(result.status).toBe(503);
  expect(result.headers["set-cookie"]).toBeUndefined();
});
test("invalid session clears cookies instead of returning any account", async () => {
  const { app } = setup({ resolve: async () => null });
  const result = await request(app).get("/api/auth/session").set("cookie", "fwp-access=old; fwp-refresh=old");
  expect(result.body.user).toBeNull();
  expect((result.headers["set-cookie"] as unknown as string[]).every(value => value.includes("Max-Age=0"))).toBe(true);
});
test("logout clears browser tokens even if provider revocation fails", async () => {
  const { app } = setup({ logout: async () => false });
  const result = await write(app, "/api/auth/logout", {}).set("cookie", "fwp-access=valid; fwp-refresh=valid");
  expect(result.body).toEqual({ signedOut: true, revocationComplete: false });
  expect((result.headers["set-cookie"] as unknown as string[]).every(value => value.includes("Max-Age=0"))).toBe(true);
});
test("deletion requires explicit intent and stays bound to the signed-in session", async () => {
  const { app, service } = setup();
  expect((await write(app, "/api/account/deletion-request", { confirmation: "yes" })).status).toBe(400);
  expect(service.requestDeletion).not.toHaveBeenCalled();
  expect((await write(app, "/api/account/deletion-request", { confirmation: "DELETE" })).status).toBe(200);
  expect(service.requestDeletion).toHaveBeenCalledWith(session);
});
test("cancellation cannot target another user's deletion request", async () => {
  const { app, service } = setup();
  expect((await write(app, "/api/account/cancel-deletion", { user_id: "other" })).status).toBe(400);
  expect(service.cancelDeletion).not.toHaveBeenCalled();
  expect((await write(app, "/api/account/cancel-deletion", {})).status).toBe(200);
  expect(service.cancelDeletion).toHaveBeenCalledWith(session);
});
