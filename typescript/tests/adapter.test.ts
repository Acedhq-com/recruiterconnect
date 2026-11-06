import { afterEach, expect, test, vi } from "vitest";
import { loadTarget } from "../src/adapter.js";

afterEach(() => vi.unstubAllEnvs());

test("default adapter is callable", async () => {
  vi.stubEnv("DISCOVERY_REQUIRE_PRODUCTION", "");
  vi.stubEnv("DISCOVERY_TS_TARGET", "");
  expect(typeof await loadTarget()).toBe("function");
});

test.each(["", "./typescript/src/reference.ts"])(
  "enforced production rejects reference or missing target %j", async (target) => {
    vi.stubEnv("DISCOVERY_REQUIRE_PRODUCTION", "1");
    vi.stubEnv("DISCOVERY_TS_TARGET", target);
    await expect(loadTarget()).rejects.toThrow("Production mode requires");
  }
);

test("missing adapter module is an error, not a skip", async () => {
  vi.stubEnv("DISCOVERY_TS_TARGET", "./no-such-recruiterconnect-adapter.ts");
  await expect(loadTarget()).rejects.toThrow();
});

test("a non-evaluator module cannot silently fall back", async () => {
  vi.stubEnv("DISCOVERY_REQUIRE_PRODUCTION", "");
  vi.stubEnv("DISCOVERY_TS_TARGET", "./typescript/src/fixtures.ts");
  await expect(loadTarget()).rejects.toThrow("must export a callable evaluate");
});
