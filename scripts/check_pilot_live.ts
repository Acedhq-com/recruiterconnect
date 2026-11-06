import assert from "node:assert/strict";
import { PostgrestClient } from "@supabase/postgrest-js";

assert(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY, "Missing pilot configuration");
const client = new PostgrestClient(`${process.env.SUPABASE_URL}/rest/v1`, {
  headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY },
});
const email = `qa+recruiterconnect-${Date.now()}@example.com`;
const input = {
  p_email: email, p_name: '=SUM(1,2) "quoted"',
  p_organization: '<script>alert("synthetic")</script>',
  p_audience: "recruiter", p_plan: "founding", p_consent: true,
};
const noConsent = await client.rpc("register_pilot_interest", { ...input, p_consent: false });
assert(noConsent.error, "Consent must be enforced by the real database");
const created = await client.rpc("register_pilot_interest", input);
assert.equal(created.error, null, created.error?.message);
assert.equal(created.data, true);
const duplicate = await client.rpc("register_pilot_interest", input);
assert.equal(duplicate.error, null);
assert.equal(duplicate.data, true);
const read = await client.from("pilot_leads").select("id,email");
assert(read.error, "Anonymous reads must be denied");
const directWrite = await client.from("pilot_leads").insert({
  email: `forbidden-${email}`, name: "Forbidden", organization: "Synthetic",
  audience: "recruiter", plan: "founding",
});
assert(directWrite.error, "Direct anonymous inserts must be denied");
console.log(JSON.stringify({
  livePilotChecks: "passed", syntheticEmail: email,
  checks: ["required consent", "bounded RPC insert", "idempotent duplicate", "anonymous read denied", "direct insert denied"],
}));
// Use the owner's database connector to verify the exact text round trip and
// remove ONLY this syntheticEmail after the check. This client cannot read/delete leads.
