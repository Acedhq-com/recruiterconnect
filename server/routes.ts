import type { Express } from "express";
import { insertPilotLeadSchema } from "../shared/schema.js";
import { storage } from "./storage.js";
import type { IStorage } from "./storage.js";

export function registerRoutes(app: Express, store: IStorage = storage): void {
  app.get("/api/status", (_request, response) => {
    response.set("Cache-Control", "no-store").json({ intakeReady: store.ready(), mode: "sample-preview", billingEnabled: false });
  });
  app.post("/api/pilot", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const origin = request.get("origin");
    if (origin) {
      try {
        const opaquePreview = origin === "null" && process.env.ALLOW_PREVIEW_PROXY === "1";
        const requestHost = request.get("host") ?? "";
        const originHost = opaquePreview ? requestHost : new URL(origin).host;
        const isPreviewProxy = process.env.ALLOW_PREVIEW_PROXY === "1"
          && (originHost === "www.perplexity.ai" || originHost === "perplexity.ai" || originHost.endsWith(".pplx.app"));
        if (originHost !== requestHost && !isPreviewProxy) {
          response.status(403).json({ message: "Please submit the form from the Find Work Privately website." });
          return;
        }
      } catch {
        response.status(403).json({ message: "This request origin is not supported." });
        return;
      }
    }
    const parsed = insertPilotLeadSchema.safeParse(request.body);
    if (!parsed.success || (parsed.success && (parsed.data.audience === "candidate") !== (parsed.data.plan === "candidate"))) {
      response.status(400).json({ message: "Please provide a valid name, email, company or field, and consent for the selected pilot." });
      return;
    }
    if (!store.ready()) {
      response.status(503).json({ message: "Pilot signup storage is not connected yet. Nothing has been submitted." });
      return;
    }
    try {
      await store.createPilotLead(parsed.data);
      response.status(201).json({ accepted: true });
    } catch (error) {
      response.status(error instanceof Error && error.message === "INTAKE_FULL" ? 429 : 503)
        .json({ message: "Pilot signup is temporarily unavailable. Please try again later." });
    }
  });
  app.all("/api/*path", (_request, response) => {
    response.status(404).set("Cache-Control", "no-store").json({ message: "This API route is not available." });
  });
}
