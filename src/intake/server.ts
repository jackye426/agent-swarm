import express from "express";
import { githubRouter } from "./routes/github.js";

// Raw body buffer is required for HMAC signature verification on the GitHub webhook.
// Must be set up before any body-parsing middleware.
export function createServer(): express.Application {
  const app = express();

  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "taskgraph-intake" });
  });

  app.use(githubRouter);

  return app;
}

export async function startServer(port: number): Promise<void> {
  const app = createServer();
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(`[Intake] HTTP server listening on port ${port}`);
      resolve();
    });
  });
}
