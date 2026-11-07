import type { Express, Request, Response } from "express";
import { z } from "zod";
import { AccountError, accountService } from "./account-service.js";
import type { IAccountService, VerifiedSession } from "./account-service.js";
import { assertAccountWrite, privateAccountResponse, resolveAccountSession } from "./account-routes.js";
import { careerStorage } from "./career-service.js";
import type { ICareerStorage } from "./career-service.js";
import { liveFeed } from "./vendor/jobtracker/live-feed.mjs";
import { removeDocumentSchema, saveBackgroundSchema, saveDocumentSchema, saveWorkflowSchema } from "../shared/career-schema.js";
import type { CareerFeed } from "../shared/career-schema.js";

export function registerCareerRoutes(app: Express, accounts: IAccountService = accountService,
  storage: ICareerStorage = careerStorage, feed: { get(): Promise<CareerFeed> } = liveFeed): void {
  app.get("/api/jobs", async (request, response) => {
    if (Object.keys(request.query).length) {
      response.status(400).set("Cache-Control", "no-store").json({ message: "Use the on-page filters. Custom feed URLs are not accepted." });
      return;
    }
    try {
      const result = await feed.get();
      response.set("Cache-Control", result.status === "unavailable" ? "no-store" : "public, max-age=0, s-maxage=300, stale-while-revalidate=60").json(result);
    } catch {
      response.status(503).set("Cache-Control", "no-store").json({ message: "Employer sources are temporarily unavailable. No fictional listings were substituted." });
    }
  });
  async function owner(request: Request, response: Response): Promise<VerifiedSession> {
    if (!accounts.enabled()) throw new AccountError(503, "Private saving is waiting for verified account email setup. Export temporary work before reloading.");
    const session = (await resolveAccountSession(request, response, accounts))!;
    // A stale tab must not accidentally save one account's draft to another account
    // after its cookie changes. This header is a consistency check, not authority.
    if (request.get("X-Account-Id") !== session.user.id) {
      throw new AccountError(409, "The signed-in account changed. Reload before accessing a private workspace.");
    }
    const { account } = await accounts.records(session);
    if (account && account.user_id !== session.user.id) throw new AccountError(503, "Account ownership could not be verified.");
    if (!account || account.account_kind !== "candidate" || account.status !== "active") {
      throw new AccountError(403, "An active candidate account is required for this private workspace.");
    }
    return session;
  }
  function route(handler: (request: Request, response: Response, session: VerifiedSession) => Promise<void>, write = false) {
    return async (request: Request, response: Response) => {
      privateAccountResponse(response);
      try {
        if (write) assertAccountWrite(request);
        await handler(request, response, await owner(request, response));
      } catch (error) {
        response.status(error instanceof AccountError ? error.status : 503).json({
          message: error instanceof AccountError ? error.message : "Private workspace access is temporarily unavailable.",
        });
      }
    };
  }
  function input<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new AccountError(400, "Check the workspace fields, dates, and version. Caller-selected owners are not accepted.");
    return result.data;
  }
  app.get("/api/career/workspace", route(async (_request, response, session) => {
    response.json(await storage.read(session));
  }));
  app.post("/api/career/background", route(async (request, response, session) => {
    const value = input(saveBackgroundSchema, request.body);
    await storage.saveBackground(session, value.content, value.expectedVersion);
    response.json(await storage.read(session));
  }, true));
  app.post("/api/career/workflow", route(async (request, response, session) => {
    await storage.saveWorkflow(session, input(saveWorkflowSchema, request.body));
    response.json(await storage.read(session));
  }, true));
  app.post("/api/career/document", route(async (request, response, session) => {
    await storage.saveDocument(session, input(saveDocumentSchema, request.body));
    response.json(await storage.read(session));
  }, true));
  app.post("/api/career/document/remove", route(async (request, response, session) => {
    const value = input(removeDocumentSchema, request.body);
    await storage.removeDocument(session, value.id, value.expectedVersion);
    response.json(await storage.read(session));
  }, true));
}
