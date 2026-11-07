import express from "express";
import type { ErrorRequestHandler } from "express";
import { registerRoutes } from "./routes.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerCareerRoutes } from "./career-routes.js";

export const app = express();
app.disable("x-powered-by");
app.use("/api/career", express.json({ limit: "224kb", strict: true }));
app.use(express.json({ limit: "12kb", strict: true }));
registerAccountRoutes(app);
registerCareerRoutes(app);
registerRoutes(app);
const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = error instanceof SyntaxError ? 400 : error.status === 413 ? 413 : 500;
  // Do not log request bodies, contact data, provider errors, or credentials.
  response.status(status).set("Cache-Control", "no-store").json({
    message: status === 413 ? "The request is too large." : status === 400 ? "Please send a valid form." : "This request could not be completed.",
  });
};
app.use(handleError);
export default app;
