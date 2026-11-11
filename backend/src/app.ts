import cors from "cors";
import express, { type Express } from "express";
import type { CoachRuntime } from "./agent/coach.js";
import type { Queue } from "./jobs/queue.js";
import { noDemoPlayers, type IsDemo } from "./lib/demo.js";
import type { Guards } from "./lib/guards.js";
import { visitorMiddleware } from "./lib/visitor.js";
import { apiNotFound, errorHandler } from "./middleware/errorHandler.js";
import { floodGuard } from "./middleware/rateLimit.js";
import { requestId } from "./middleware/requestId.js";
import { analysisRouter, type AnalysisRouterOptions } from "./routes/analysis.js";
import { askRouter } from "./routes/ask.js";
import { coachRouter } from "./routes/coach.js";
import { gamesRouter } from "./routes/games.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { playersRouter } from "./routes/players.js";
import { runsRouter } from "./routes/runs.js";
import { summaryRouter } from "./routes/summary.js";

export interface AppOptions {
  corsOrigins: string[];
  trustProxyHops: number;
  getDbStatus: () => boolean;
  queue: Pick<Queue, "enqueue" | "depth">;
  version: string;
  // The coach (report routes). Tests that don't need it leave it out.
  coach?: CoachRuntime;
  // Frozen demo players (lib/demo.ts, env DEMO_PLAYERS). None by default.
  isDemo?: IsDemo;
  // The Stage 6 guards (lib/guards.ts): visitor hash, limits, storage gate. server.ts always
  // passes them; route tests that aren't about limits leave them out (= no limits).
  guards?: Guards;
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
  coach,
  isDemo = noDemoPlayers,
  guards,
  healthCacheMs,
  sseHeartbeatMs,
  analysis,
}: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // 1. Trust proxy first, so req.ip is the real visitor for everything after it (the visitor hash
  //    and every limit). On Render: 3 hops (visitor → Cloudflare → Render's proxy → us).
  app.set("trust proxy", trustProxyHops);

  // 2. Request ID + one log line per request (no IP in it).
  app.use(requestId);

  // 2b. The visitor's hashed key on res.locals.visitor (lib/visitor.ts). The raw IP goes no further.
  if (guards) app.use(visitorMiddleware(guards.visitorKey));

  // 3. CORS allowlist. No Origin header (curl, Render's health check) is allowed;
  //    a disallowed origin gets no CORS headers, so the browser blocks the response.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || corsOrigins.includes(origin)),
    }),
  );

  // 3b. The flood guard (per visitor, per minute), after CORS so a refused browser can still read
  //     the friendly message, and before the body parser so a flood doesn't parse bodies.
  if (guards) app.use("/api", floodGuard(guards.limits.requestsPerMinute));

  // 4. JSON bodies with an explicit size limit.
  app.use(express.json({ limit: "100kb" }));

  // 5. Routes.
  app.use(
    "/api",
    healthRouter({ getDbStatus, getQueueDepth: () => queue.depth(), version, cacheMs: healthCacheMs, storage: guards?.storage }),
  );
  app.use("/api", playersRouter({ queue, isDemo, guards }));
  app.use("/api", summaryRouter({ queue }));
  app.use("/api", jobsRouter({ heartbeatMs: sseHeartbeatMs }));
  app.use("/api", gamesRouter({ isDemo }));
  app.use("/api", analysisRouter(queue, { ...analysis, isDemo }));
  if (coach) app.use("/api", coachRouter({ queue, coach, guards }));
  if (coach) app.use("/api", askRouter({ queue, coach, guards }));
  app.use("/api", runsRouter({ heartbeatMs: sseHeartbeatMs }));

  // 6. Unknown /api routes → 404 JSON, then the error handler last.
  app.use("/api", apiNotFound);
  app.use(errorHandler);

  return app;
}
