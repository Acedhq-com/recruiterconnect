import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { app } from "./app.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const server = createServer(app);
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve(import.meta.dirname, "../dist/public")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT ?? 5000);
server.listen(port, "0.0.0.0", () => console.log(`RecruiterConnect listening on port ${port}`));
