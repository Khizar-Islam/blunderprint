import cors from "cors";
import express, { type Express } from "express";
import type { Queue } from "./jobs/queue.js";
import { apiNotFound, errorHandler } from "./middleware/errorHandler.js";
import { requestId } from "./middleware/requestId.js";
import { analysisRouter, type AnalysisRouterOptions } from "./routes/analysis.js";
import { gamesRouter } from "./routes/games.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { playersRouter } from "./routes/players.js";

export interface AppOptions {
  corsOrigins: string[];
  trustProxyHops: number;
  getDbStatus: () => boolean;
  queue: Pick<Queue, "enqueue" | "depth">;
  version: string;
  // Tests shorten these.
  healthCacheMs?: number;
  sseHeartbeatMs?: number;
  analysis?: AnalysisRouterOptions;
}

// Builds the Express app without starting it, so tests can run it on a random port.
// Middleware order matters and is commented step by step.
export function createApp({
  corsOrigins,
  trustProxyHops,
  getDbStatus,
  queue,
  version,
  healthCacheMs,
  sseHeartbeatMs,
  analysis,
}: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // 1. Trust proxy first, so req.ip is the real visitor for everything after it (rate limiters in Stage 6).
  app.set("trust proxy", trustProxyHops);

  // 2. Request ID + one log line per request.
  app.use(requestId);

  // 3. CORS allowlist. No Origin header (curl, Render's health check) is allowed;
  //    a disallowed origin gets no CORS headers, so the browser blocks the response.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || corsOrigins.includes(origin)),
    }),
  );

  // 4. JSON bodies with an explicit size limit.
  app.use(express.json({ limit: "100kb" }));

  // 5. Routes.
  app.use("/api", healthRouter({ getDbStatus, getQueueDepth: () => queue.depth(), version, cacheMs: healthCacheMs }));
  app.use("/api", playersRouter({ queue }));
  app.use("/api", jobsRouter({ heartbeatMs: sseHeartbeatMs }));
  app.use("/api", gamesRouter());
  app.use("/api", analysisRouter(analysis));

  // 6. Unknown /api routes → 404 JSON, then the error handler last.
  app.use("/api", apiNotFound);
  app.use(errorHandler);

  return app;
}
