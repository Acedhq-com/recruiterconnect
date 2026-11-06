import { readFileSync, writeFileSync } from "node:fs";
import { loadTarget } from "../typescript/src/adapter.js";
import { CASES, materialize } from "../typescript/src/fixtures.js";

const reports = new URL("../reports/", import.meta.url);
const marker: unknown = JSON.parse(readFileSync(new URL("run-start.json", reports), "utf8"));
const mode = process.env.DISCOVERY_REQUIRE_PRODUCTION === "1" ? "production" : "reference";
if (marker === null || typeof marker !== "object" || !("run_id" in marker)
    || typeof marker.run_id !== "string" || !("mode" in marker) || marker.mode !== mode) {
  throw new Error("Missing/invalid run marker or exporter mode changed; run the CI --start command");
}
const evaluate = await loadTarget();
writeFileSync(new URL("typescript-contract.json", reports), JSON.stringify({
  run_id: marker.run_id,
  mode,
  cases: CASES.map((testCase) => ({ id: testCase.id, decision: evaluate(materialize(testCase)) }))
}, null, 2), "utf8");
console.log(`Exported ${CASES.length} TypeScript contract decisions (${mode})`);
