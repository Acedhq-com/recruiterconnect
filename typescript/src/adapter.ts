import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Decision } from "./reference.js";

export type Evaluator = (context: unknown) => Decision;

export async function loadTarget(): Promise<Evaluator> {
  const target = process.env.DISCOVERY_TS_TARGET ?? "";
  const production = process.env.DISCOVERY_REQUIRE_PRODUCTION === "1";
  if (production && (!target || /(?:^|[/\\])reference\.[cm]?[jt]s$/.test(target))) {
    throw new Error("Production mode requires DISCOVERY_TS_TARGET=./your-adapter.ts");
  }
  if (!target) return (await import("./reference.js")).evaluate;
  const specifier = target.startsWith(".") || target.startsWith("/")
    ? pathToFileURL(resolve(target)).href : target;
  const module: unknown = await import(/* @vite-ignore */ specifier);
  if (module === null || typeof module !== "object"
      || !("evaluate" in module) || typeof module.evaluate !== "function") {
    throw new TypeError("TypeScript adapter must export a callable evaluate");
  }
  if (production && module.evaluate === (await import("./reference.js")).evaluate) {
    throw new Error("Production mode cannot use the reference evaluator");
  }
  return module.evaluate as Evaluator;
}
