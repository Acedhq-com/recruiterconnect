import { afterEach, expect, test, vi } from "vitest";
import { backgroundSchema, emptyBackground, jobSnapshotSchema } from "../shared/career-schema.js";
import { SupabaseCareerStorage } from "../server/career-service.js";
import type { VerifiedSession } from "../server/account-service.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Direct-RPC parity controls and fail-closed reads of historical malformed rows.
test.each([
  "https://127.0.0.1/audit", "https://jobs.internal/audit",
  "https://jobs.example.com:444/audit", "https://user:password@jobs.example.com/audit",
])("audit: API rejects snapshot URL %s", url => {
  expect(jobSnapshotSchema.safeParse({
    id: "audit-job", role: "Synthetic role", company: "Audit employer", location: "Remote",
    url, source: "ashby", checkedAt: "2026-11-07T00:00:00.000Z",
  }).success).toBe(false);
});
test("audit: API rejects whitespace-only experience", () => {
  expect(backgroundSchema.safeParse({ ...emptyBackground, experience: ["   "] }).success).toBe(false);
});

test.each([
  "https://127.0.0.1/audit", "https://jobs.internal/audit", "https://jobs.example.com:444/audit",
])("audit: historical malformed snapshot URLs still fail closed on read: %s", url => {
  vi.stubEnv("SUPABASE_URL", "https://synthetic.example.test");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "synthetic-low-privilege-key");
  const uid = "11111111-1111-4111-8111-111111111111";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const rows = String(input).includes("/career_workflows") ? [{
      user_id: uid, snapshot: {
        id: "audit-job", role: "Synthetic role", company: "Audit employer", location: "Remote",
        url, source: "ashby", checkedAt: "2026-11-07T00:00:00.000Z",
      }, stage: "Saved", notes: "", next_action: "", applied_date: null,
      follow_up_date: null, version: 1,
    }] : [];
    return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
  }));
  const session: VerifiedSession = { user: { id: uid, email: "audit@example.com" }, tokens: {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresIn: 3600,
  } };
  return expect(new SupabaseCareerStorage().read(session)).rejects.toHaveProperty("name", "ZodError");
});
