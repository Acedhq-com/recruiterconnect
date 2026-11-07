import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccountError, SupabaseAccountService } from "../server/account-service.js";
import type { VerifiedSession } from "../server/account-service.js";

const userId = "95b757a9-a238-4747-a03e-1c070c638771";
const blockId = "0b2f1c52-93d5-4f6a-9d0e-3a3c6f1a7d11";
const user = {
  id: userId, email: "synthetic-account@example.com", email_confirmed_at: "2026-11-06T00:00:00Z",
  aud: "authenticated", role: "authenticated", created_at: "2026-11-06T00:00:00Z",
  is_anonymous: false, app_metadata: { provider: "email" }, user_metadata: {},
};
const jwt = (label: string) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({
  sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, session_id: "aa563cd9-45a6-4dca-a621-b9a09d9fa6e8", label,
})).toString("base64url")}.synthetic-signature`;
const rawSession = () => ({
  access_token: jwt("fresh"), refresh_token: "SYNTHETIC_REFRESH", token_type: "bearer", expires_in: 3600, user,
});
const signed = (): VerifiedSession => ({
  user: { id: userId, email: user.email },
  tokens: { accessToken: jwt("access"), refreshToken: "SYNTHETIC_REFRESH", expiresIn: 3600 },
});
type FetchCall = { url: URL; init: RequestInit };
function network(handler: (call: FetchCall) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler({ url: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url), init: init ?? {} }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://synthetic-auth.example");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "synthetic-publishable-key");
  vi.stubEnv("AUTH_EMAIL_READY", "1");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test("email delivery is disabled unless explicitly enabled", () => {
  const service = new SupabaseAccountService();
  expect(service.enabled()).toBe(true);
  vi.stubEnv("AUTH_EMAIL_READY", "0");
  expect(service.enabled()).toBe(false);
});
test("missing publishable configuration disables account auth", () => {
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");
  expect(new SupabaseAccountService().enabled()).toBe(false);
});
test("email request uses the Auth service without granting a role", async () => {
  const fetcher = network(({ url, init }) => {
    expect(url.pathname).toBe("/auth/v1/otp");
    const body = JSON.parse(String(init.body));
    expect(body.email).toBe(user.email);
    expect(body.create_user).toBe(true);
    expect(body.data?.role).toBeUndefined();
    expect(body.data?.company_verified).toBeUndefined();
    return json({});
  });
  await new SupabaseAccountService().start(user.email);
  expect(fetcher).toHaveBeenCalledOnce();
});
test("email-provider errors are sanitized", async () => {
  network(() => json({ message: "PRIVATE_SMTP_DETAILS", code: "unexpected_failure" }, 400));
  await expect(new SupabaseAccountService().start(user.email)).rejects.toMatchObject({
    status: 503, message: "Email sign-in is temporarily unavailable. Nothing has been signed in.",
  });
});
test("provider request limits stay limits", async () => {
  network(() => json({ message: "too many", code: "over_email_send_rate_limit" }, 429));
  await expect(new SupabaseAccountService().start(user.email)).rejects.toMatchObject({ status: 429 });
});
test("verified OTP also checks the database session before issuing cookies", async () => {
  network(({ url, init }) => {
    if (url.pathname === "/auth/v1/verify") {
      expect(JSON.parse(String(init.body))).toMatchObject({ email: user.email, token: "123456", type: "email" });
      return json(rawSession());
    }
    expect(url.pathname).toBe("/rest/v1/rpc/account_session_active");
    return json(true);
  });
  const value = await new SupabaseAccountService().verify(user.email, "123456");
  expect(value.user).toEqual({ id: userId, email: user.email });
  expect(value.tokens.refreshToken).toBe("SYNTHETIC_REFRESH");
});
test("user metadata cannot substitute for server-confirmed email", async () => {
  network(() => json({ ...rawSession(), user: { ...user, email_confirmed_at: null, user_metadata: { email_verified: true } } }));
  await expect(new SupabaseAccountService().verify(user.email, "123456")).rejects.toMatchObject({ status: 401 });
});
test("anonymous identities cannot become real private accounts", async () => {
  network(() => json({ ...rawSession(), user: { ...user, is_anonymous: true } }));
  await expect(new SupabaseAccountService().verify(user.email, "123456")).rejects.toMatchObject({ status: 401 });
});
test("a revoked database session defeats an otherwise valid OTP response", async () => {
  network(({ url }) => url.pathname === "/auth/v1/verify" ? json(rawSession()) : json(false));
  await expect(new SupabaseAccountService().verify(user.email, "123456")).rejects.toMatchObject({ status: 401 });
});
test("malformed or expired OTP responses never expose provider messages", async () => {
  network(() => json({ message: "TOKEN_AND_PROVIDER_DETAIL", code: "otp_expired" }, 403));
  await expect(new SupabaseAccountService().verify(user.email, "123456")).rejects.toMatchObject({
    status: 401, message: "The code is invalid or expired. Request a new code and try again.",
  });
});
test("no-cookie session resolution performs no network request", async () => {
  const fetcher = network(() => { throw new Error("Unexpected network call"); });
  expect(await new SupabaseAccountService().resolve()).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
test("current-user resolution verifies with Auth and checks session revocation", async () => {
  const value = signed();
  network(({ url, init }) => {
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${value.tokens.accessToken}`);
    return url.pathname === "/auth/v1/user" ? json(user) : json(true);
  });
  expect((await new SupabaseAccountService().resolve(value.tokens.accessToken, value.tokens.refreshToken))?.user.id).toBe(userId);
});
test("a revoked session is not accepted just because getUser returned an identity", async () => {
  network(({ url }) => url.pathname === "/auth/v1/user" ? json(user) : json(false));
  expect(await new SupabaseAccountService().resolve(jwt("revoked"), "refresh")).toBeNull();
});
test("expired access can rotate a valid refresh token", async () => {
  const fresh = rawSession();
  network(({ url }) => {
    if (url.pathname === "/auth/v1/user") return json({ message: "expired", code: "bad_jwt" }, 401);
    if (url.pathname === "/auth/v1/token") {
      expect(url.searchParams.get("grant_type")).toBe("refresh_token");
      return json(fresh);
    }
    return json(true);
  });
  const value = await new SupabaseAccountService().resolve(jwt("expired"), "refresh");
  expect(value?.tokens.accessToken).toBe(fresh.access_token);
});
test("invalid refresh tokens produce no private identity", async () => {
  network(() => json({ message: "invalid refresh", code: "refresh_token_not_found" }, 400));
  expect(await new SupabaseAccountService().resolve(undefined, "invalid")).toBeNull();
});
test("record queries are scoped to the verified user and use their JWT", async () => {
  const value = signed();
  network(({ url, init }) => {
    expect(url.searchParams.get("user_id")).toBe(`eq.${userId}`);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${value.tokens.accessToken}`);
    if (url.pathname.endsWith("/member_accounts")) {
      return json([{ user_id: userId, account_kind: "candidate", display_name: "Private", status: "active", deletion_requested_at: null }]);
    }
    if (url.pathname.endsWith("/candidate_private")) return json([{ current_employer: "Private Employer LLP" }]);
    if (url.pathname.endsWith("/candidate_blocks")) {
      return json([{ id: blockId, company_name: "Private Employer LLP", source: "current_employer" }]);
    }
    return json([{ headline: "Private", skills: [], work_preference: "Remote", discovery_active: false, version: 1 }]);
  });
  const records = await new SupabaseAccountService().records(value);
  expect(records.profile?.discovery_active).toBe(false);
  expect(records.privacy).toEqual({ current_employer: "Private Employer LLP",
    blocks: [{ id: blockId, company_name: "Private Employer LLP", source: "current_employer" }] });
});
test("a candidate with no employer or blocks yet gets an empty privacy record", async () => {
  network(({ url }) => {
    if (url.pathname.endsWith("/member_accounts")) {
      return json([{ user_id: userId, account_kind: "candidate", display_name: "Private", status: "active", deletion_requested_at: null }]);
    }
    if (url.pathname.endsWith("/candidate_blocks")) return json([]);
    if (url.pathname.endsWith("/candidate_private")) return json([]);
    return json([{ headline: "Private", skills: [], work_preference: "Remote", discovery_active: false, version: 1 }]);
  });
  expect((await new SupabaseAccountService().records(signed())).privacy).toEqual({ current_employer: null, blocks: [] });
});
test.each([
  ["a block row with an unknown source", [{ id: blockId, company_name: "Firm", source: "admin" }]],
  ["a block row with an extra column", [{ id: blockId, company_name: "Firm", source: "candidate", user_id: userId }]],
  ["a block row with a non-UUID id", [{ id: "1", company_name: "Firm", source: "candidate" }]],
  ["more than 50 blocks", Array.from({ length: 51 }, (_, n) => ({
    id: `0b2f1c52-93d5-4f6a-9d0e-${String(n).padStart(12, "0")}`, company_name: `Firm ${n}`, source: "candidate" }))],
])("%s fails closed instead of showing an untrustworthy block list", async (_label, rows) => {
  network(({ url }) => {
    if (url.pathname.endsWith("/member_accounts")) {
      return json([{ user_id: userId, account_kind: "candidate", display_name: "Private", status: "active", deletion_requested_at: null }]);
    }
    if (url.pathname.endsWith("/candidate_blocks")) return json(rows);
    if (url.pathname.endsWith("/candidate_private")) return json([]);
    return json([{ headline: "Private", skills: [], work_preference: "Remote", discovery_active: false, version: 1 }]);
  });
  await expect(new SupabaseAccountService().records(signed())).rejects.toMatchObject({ status: 503 });
});
test("a recruiter account does not load candidate privacy records", async () => {
  const fetcher = network(() => json([{ user_id: userId, account_kind: "recruiter",
    display_name: "Private recruiter", status: "active", deletion_requested_at: null }]));
  expect((await new SupabaseAccountService().records(signed())).privacy).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
test.each([
  ["saveEmployer", "save_my_current_employer", { p_employer: "Acme LLP" }, (svc: SupabaseAccountService) => svc.saveEmployer(signed(), "Acme LLP")],
  ["addBlock", "add_my_block", { p_company: "Acme LLP" }, (svc: SupabaseAccountService) => svc.addBlock(signed(), "Acme LLP")],
  ["removeBlock", "remove_my_block", { p_id: blockId }, (svc: SupabaseAccountService) => svc.removeBlock(signed(), blockId)],
] as const)("%s calls only the fixed %s RPC with the user's JWT", async (_name, rpc, body, call) => {
  const value = signed();
  network(({ url, init }) => {
    expect(url.pathname).toBe(`/rest/v1/rpc/${rpc}`);
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${value.tokens.accessToken}`);
    return json(null);
  });
  await call(new SupabaseAccountService());
});
test("a full block list is a clear conflict, not a generic outage", async () => {
  network(() => json({ code: "54000", message: "PRIVATE_DATABASE_DETAIL" }, 400));
  await expect(new SupabaseAccountService().addBlock(signed(), "One Too Many")).rejects.toMatchObject({
    status: 409, message: expect.stringContaining("50"),
  });
});
test("a recruiter account does not load private candidate drafts", async () => {
  const fetcher = network(() => json([{ user_id: userId, account_kind: "recruiter",
    display_name: "Private recruiter", status: "active", deletion_requested_at: null }]));
  expect((await new SupabaseAccountService().records(signed())).profile).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
test("an unexpectedly active draft fails closed in this account-only release", async () => {
  network(({ url }) => url.pathname.endsWith("/member_accounts")
    ? json([{ user_id: userId, account_kind: "candidate", display_name: "Private", status: "active", deletion_requested_at: null }])
    : json([{ headline: "Unexpected", skills: [], work_preference: "Remote", discovery_active: true, version: 1 }]));
  await expect(new SupabaseAccountService().records(signed())).rejects.toMatchObject({ status: 503 });
});
test("onboarding persists only safe fields and the explicit beta acknowledgment", async () => {
  network(({ url, init }) => {
    expect(url.pathname).toBe("/rest/v1/rpc/onboard_my_account");
    expect(JSON.parse(String(init.body))).toEqual({ p_kind: "candidate", p_display_name: "Private", p_beta_ack: true });
    return json(null);
  });
  await new SupabaseAccountService().onboard(signed(), { kind: "candidate", displayName: "Private", acknowledgePrivateBeta: true });
});
test.each([["42501", 403], ["40001", 409], ["22023", 400], ["OTHER", 503]] as const)(
  "database code %s maps to a sanitized %s", async (code, status) => {
    network(() => json({ code, message: "PRIVATE_DATABASE_DETAIL" }, 400));
    try {
      await new SupabaseAccountService().saveProfile(signed(), {
        displayName: "Private", headline: "Private draft", skills: [], workPreference: "Remote", expectedVersion: 1,
      });
      throw new Error("Expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountError);
      expect((error as AccountError).status).toBe(status);
      expect((error as Error).message).not.toContain("PRIVATE_DATABASE_DETAIL");
    }
  });
test("deletion actions carry no caller-selected account ID", async () => {
  const calls: string[] = [];
  network(({ url, init }) => { calls.push(url.pathname); expect(JSON.parse(String(init.body))).toEqual({}); return json(null); });
  const service = new SupabaseAccountService();
  await service.requestDeletion(signed());
  await service.cancelDeletion(signed());
  expect(calls).toEqual(["/rest/v1/rpc/request_my_account_deletion", "/rest/v1/rpc/cancel_my_account_deletion"]);
});
test("sign-out targets the current user session, not a privileged admin endpoint", async () => {
  const value = signed();
  network(({ url, init }) => {
    expect(url.pathname).toBe("/auth/v1/logout");
    expect(url.searchParams.get("scope")).toBe("local");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${value.tokens.accessToken}`);
    return new Response(null, { status: 204 });
  });
  expect(await new SupabaseAccountService().logout(value.tokens.accessToken)).toBe(true);
});
