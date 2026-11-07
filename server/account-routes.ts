import type { Express, Request, Response } from "express";
import { parse, serialize } from "cookie";
import {
  PUBLIC_APP_ORIGIN, deletionRequestSchema, emptyAccountActionSchema,
  onboardAccountSchema, savePrivateProfileSchema, startEmailSchema, verifyEmailSchema,
} from "../shared/account-schema.js";
import type { PublicAccountSession } from "../shared/account-schema.js";
import { AccountError, accountService } from "./account-service.js";
import type { IAccountService, VerifiedSession } from "./account-service.js";

function secure(): boolean { return process.env.VERCEL === "1" || process.env.NODE_ENV === "production"; }
function cookieNames(): { access: string; refresh: string } {
  return { access: secure() ? "__Host-fwp-access" : "fwp-access",
    refresh: secure() ? "__Host-fwp-refresh" : "fwp-refresh" };
}
function readCookies(request: Request): { access?: string; refresh?: string } {
  const data = parse(request.get("cookie") ?? "");
  const names = cookieNames();
  const access = data[names.access];
  const refresh = data[names.refresh];
  return { ...(access ? { access } : {}), ...(refresh ? { refresh } : {}) };
}
function writeCookies(response: Response, session: VerifiedSession | null): void {
  const names = cookieNames();
  const common = { httpOnly: true, secure: secure(), sameSite: "lax" as const, path: "/" };
  response.setHeader("Set-Cookie", [
    serialize(names.access, session?.tokens.accessToken ?? "", { ...common, maxAge: session ? Math.max(1, session.tokens.expiresIn) : 0 }),
    serialize(names.refresh, session?.tokens.refreshToken ?? "", { ...common, maxAge: session ? 7 * 86400 : 0 }),
  ]);
}
function privateResponse(response: Response): void {
  response.set({ "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" });
}
function assertWrite(request: Request): void {
  if (!request.is("application/json")) throw new AccountError(415, "Send a JSON account request.");
  const origin = request.get("origin");
  if (!origin) throw new AccountError(403, "Open account sign-in directly on FindWorkPrivately.com.");
  try {
    const url = new URL(origin);
    const expected = new URL(process.env.APP_ORIGIN ?? PUBLIC_APP_ORIGIN);
    const development = !secure() && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.host !== request.get("host") || (!development && url.origin !== expected.origin)) {
      throw new Error("origin mismatch");
    }
  } catch { throw new AccountError(403, "Open account sign-in directly on FindWorkPrivately.com."); }
}

export { assertWrite as assertAccountWrite, privateResponse as privateAccountResponse };
export async function resolveAccountSession(request: Request, response: Response,
  service: IAccountService, required = true): Promise<VerifiedSession | null> {
  const cookies = readCookies(request);
  const session = await service.resolve(cookies.access, cookies.refresh);
  if (!session) {
    if (cookies.access || cookies.refresh) writeCookies(response, null);
    if (required) throw new AccountError(401, "Sign in with your email code to continue.");
    return null;
  }
  const expectedOwner = request.get("X-Account-Id");
  if (expectedOwner && expectedOwner !== session.user.id) {
    throw new AccountError(409, "The signed-in account changed. Reload before changing private account details.");
  }
  if (session.tokens.accessToken !== cookies.access || session.tokens.refreshToken !== cookies.refresh) writeCookies(response, session);
  return session;
}

export function registerAccountRoutes(app: Express, service: IAccountService = accountService): void {
  const meta = () => ({ authEnabled: service.enabled(), appOrigin: process.env.APP_ORIGIN ?? PUBLIC_APP_ORIGIN,
    method: "email-code" as const });
  const current = (request: Request, response: Response, required = true) =>
    resolveAccountSession(request, response, service, required);
  async function envelope(session: VerifiedSession | null): Promise<PublicAccountSession> {
    const records = session ? await service.records(session) : { account: null, profile: null };
    if (session && records.account && records.account.user_id !== session.user.id) {
      throw new AccountError(503, "Account ownership could not be verified.");
    }
    return { user: session?.user ?? null, ...records, ...meta() };
  }
  function route(handler: (request: Request, response: Response) => Promise<void>, write = false) {
    return async (request: Request, response: Response) => {
      privateResponse(response);
      try {
        if (write) assertWrite(request);
        await handler(request, response);
      } catch (error) {
        const known = error instanceof AccountError;
        response.status(known ? error.status : 503).json({
          message: known ? error.message : "Account access is temporarily unavailable. Please try again.",
        });
      }
    };
  }
  function requireEnabled(): void {
    if (!service.enabled()) throw new AccountError(503, "Secure account email is not enabled yet. Pilot signup is still available.");
  }
  app.get("/api/auth/session", route(async (request, response) => {
    // Do not make Auth-provider requests just to render an unconfigured preview.
    response.json(await envelope(service.enabled() ? await current(request, response, false) : null));
  }));
  app.post("/api/auth/start", route(async (request, response) => {
    requireEnabled();
    const input = startEmailSchema.safeParse(request.body);
    if (!input.success) throw new AccountError(400, "Enter a valid email address.");
    await service.start(input.data.email, input.data.captchaToken);
    response.status(202).json({ accepted: true, message: "Check your email for a one-time sign-in code." });
  }, true));
  app.post("/api/auth/verify", route(async (request, response) => {
    requireEnabled();
    const input = verifyEmailSchema.safeParse(request.body);
    if (!input.success) throw new AccountError(400, "Enter your email and the code from that email.");
    const session = await service.verify(input.data.email, input.data.code);
    const output = await envelope(session);
    writeCookies(response, session);
    response.json(output);
  }, true));
  app.post("/api/auth/logout", route(async (request, response) => {
    const input = emptyAccountActionSchema.safeParse(request.body);
    if (!input.success) throw new AccountError(400, "Invalid sign-out request.");
    const cookies = readCookies(request);
    writeCookies(response, null);
    let revoked = !cookies.access && !cookies.refresh;
    try {
      let accessToken = cookies.access;
      // Clearing cookies is not provider revocation. A refresh-only session
      // still needs resolving and revoking, without writing rotated cookies.
      if (!accessToken && cookies.refresh) {
        const session = await service.resolve(cookies.access, cookies.refresh);
        accessToken = session?.tokens.accessToken;
      }
      if (accessToken) revoked = await service.logout(accessToken);
    } catch {
      // Browser logout remains available when the provider is unavailable,
      // but the response must not claim the remote session was revoked.
      revoked = false;
    }
    response.json({ signedOut: true, revocationComplete: revoked });
  }, true));
  app.post("/api/account/onboard", route(async (request, response) => {
    requireEnabled();
    const input = onboardAccountSchema.safeParse(request.body);
    if (!input.success) throw new AccountError(400, "Choose an account type, add your private name, and acknowledge the beta.");
    const session = (await current(request, response))!;
    await service.onboard(session, input.data);
    response.json(await envelope(session));
  }, true));
  app.post("/api/account/profile", route(async (request, response) => {
    requireEnabled();
    const input = savePrivateProfileSchema.safeParse(request.body);
    if (!input.success) throw new AccountError(400, "Check your private profile fields and try again.");
    const session = (await current(request, response))!;
    await service.saveProfile(session, input.data);
    response.json(await envelope(session));
  }, true));
  app.post("/api/account/deletion-request", route(async (request, response) => {
    requireEnabled();
    if (!deletionRequestSchema.safeParse(request.body).success) {
      throw new AccountError(400, "Confirm that you want to request account deletion.");
    }
    const session = (await current(request, response))!;
    await service.requestDeletion(session);
    response.json(await envelope(session));
  }, true));
  app.post("/api/account/cancel-deletion", route(async (request, response) => {
    requireEnabled();
    if (!emptyAccountActionSchema.safeParse(request.body).success) throw new AccountError(400, "Invalid account request.");
    const session = (await current(request, response))!;
    await service.cancelDeletion(session);
    response.json(await envelope(session));
  }, true));
}
