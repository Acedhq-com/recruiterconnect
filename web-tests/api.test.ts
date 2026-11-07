import express from "express";
import request from "supertest";
import { expect, test, vi } from "vitest";
import { registerRoutes } from "../server/routes.js";
import app from "../server/app.js";
import type { IStorage } from "../server/storage.js";

const valid = { name: "Example Person", email: "person@example.com", organization: "Example Co", audience: "recruiter", plan: "founding", consent: true, website: "" };
function testApp(ready = true, failure?: string) {
  const store: IStorage = {
    ready: () => ready,
    createPilotLead: vi.fn(async () => { if (failure) throw new Error(failure); }),
  };
  const api = express();
  api.use(express.json());
  registerRoutes(api, store);
  return { api, store };
}
test("status distinguishes sample mode from billing and intake capability", async () => {
  const { api } = testApp(false);
  const result = await request(api).get("/api/status");
  expect(result.body).toEqual({ intakeReady: false, mode: "sample-preview", billingEnabled: false });
  expect(result.headers["cache-control"]).toBe("no-store");
});
test("valid signup persists before success is reported", async () => {
  const { api, store } = testApp();
  const result = await request(api).post("/api/pilot").send(valid);
  expect(result.status).toBe(201);
  expect(result.body).toEqual({ accepted: true });
  expect(store.createPilotLead).toHaveBeenCalledOnce();
});
test("a candidate LinkedIn research access request is accepted", async () => {
  const { api, store } = testApp();
  const result = await request(api).post("/api/pilot").send({ ...valid, audience: "candidate", plan: "research" });
  expect(result.status).toBe(201);
  expect(store.createPilotLead).toHaveBeenCalledWith(expect.objectContaining({ audience: "candidate", plan: "research" }));
});
test("an unavailable store never produces a false success", async () => {
  const { api, store } = testApp(false);
  expect((await request(api).post("/api/pilot").send(valid)).status).toBe(503);
  expect(store.createPilotLead).not.toHaveBeenCalled();
});
test.each([
  { consent: false }, { email: "bad" }, { plan: "candidate" }, { role: "admin" },
  { website: "spam" }, { audience: "candidate", plan: "founding" }, { plan: "research" },
  { audience: "candidate", plan: "team" },
])("invalid intake %j does not reach storage", async patch => {
  const { api, store } = testApp();
  expect((await request(api).post("/api/pilot").send({ ...valid, ...patch })).status).toBe(400);
  expect(store.createPilotLead).not.toHaveBeenCalled();
});
test("an untrusted website cannot submit a cross-origin signup", async () => {
  const { api, store } = testApp();
  const result = await request(api).post("/api/pilot").set("origin", "https://not-our-site.example").send(valid);
  expect(result.status).toBe(403);
  expect(store.createPilotLead).not.toHaveBeenCalled();
});
test("internal provider failures never leak diagnostics or contact records", async () => {
  const { api } = testApp(true, "SECRET_PROVIDER_ERROR");
  const result = await request(api).post("/api/pilot").send(valid);
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).not.toContain("SECRET_PROVIDER_ERROR");
  expect(JSON.stringify(result.body)).not.toContain(valid.email);
});
test("pilot-wide intake cap is returned as a retriable limit", async () => {
  const { api } = testApp(true, "INTAKE_FULL");
  expect((await request(api).post("/api/pilot").send(valid)).status).toBe(429);
});
test("there is no public lead-directory endpoint", async () => {
  const { api } = testApp();
  expect((await request(api).get("/api/leads")).status).toBe(404);
});
test("malformed JSON produces a safe response", async () => {
  const result = await request(app).post("/api/pilot").set("Content-Type", "application/json").send('{"bad":');
  expect(result.status).toBe(400);
  expect(result.body.message).toBe("Please send a valid form.");
});
