import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "client/src") } },
  root: resolve(import.meta.dirname, "client"),
  base: "./",
  build: { outDir: resolve(import.meta.dirname, "dist/public"), emptyOutDir: true },
  server: { fs: { strict: true, allow: [import.meta.dirname], deny: ["**/.*"] } },
});
