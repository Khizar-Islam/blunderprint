import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { loadEnv, type Env } from "./config/env.js";
import { connectWithRetry, disconnectDb, isDbConnected } from "./db/connect.js";
import { AgentRun } from "./db/models/agentRun.js";
import { Game } from "./db/models/game.js";
import { Job } from "./db/models/job.js";
import { Player } from "./db/models/player.js";
import { Report } from "./db/models/report.js";
import { Usage } from "./db/models/usage.js";
import { createJobSystem } from "./jobs/setup.js";
import { startWorker, type Worker } from "./jobs/worker.js";
import { logger } from "./lib/logger.js";
import { VERSION } from "./lib/version.js";
import { createShutdown } from "./shutdown.js";

let env: Env;
try {
  env = loadEnv();
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

logger.info(`Trust proxy hops: ${env.TRUST_PROXY_HOPS}`);
if (env.isRender && env.TRUST_PROXY_HOPS === 0) {
  logger.warn("Running on Render with TRUST_PROXY_HOPS=0: every visitor will share one IP. Set it to 3.");
}

const { queue, handlers, coach, lanes } = createJobSystem(env);
logger.info("Coach", { model: coach.modelName, available: coach.available, dailyBudget: env.AI_DAILY_CALL_BUDGET });

const app = createApp({
  corsOrigins: env.corsOrigins,
  trustProxyHops: env.TRUST_PROXY_HOPS,
  getDbStatus: isDbConnected,
  queue,
  version: VERSION,
  coach,
});

// Startup order: listen → connect → indexes → worker.
// Listen first: /api/health answers (db:false) while Atlas is still connecting, so Render
// sees a live service during a slow cold start.
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on :${env.PORT}`, { version: VERSION, corsOrigins: env.corsOrigins });
});

const workers: Worker[] = [];
let shuttingDown = false;

void (async () => {
  await connectWithRetry(env.MONGODB_URI);
  if (shuttingDown) return;
  // Build any missing indexes before the worker runs: the job queue's idempotency relies on the
  // unique partial index on jobs.key, imports rely on the unique { playerId, sourceId }, and the
  // report cache on the unique report key. Already-built indexes make this a quick no-op.
  await Promise.all([Player.init(), Game.init(), Job.init(), Report.init(), AgentRun.init(), Usage.init()]);
  if (shuttingDown) return;
  // Expired leases from a previous run (crash, Render sleep) are reaped on the first loop turn.
  // Two lanes: imports and extracts in one, coach reports in the other, so a report that spends
  // a minute waiting on the AI never holds up an import.
  workers.push(startWorker({ queue, handlers, claimFilter: lanes.main }));
  workers.push(startWorker({ queue, handlers, claimFilter: lanes.coach, workerId: `coach-${randomUUID().slice(0, 8)}` }));
})().catch((err: unknown) => {
  // Reaching here means the indexes couldn't be built: running without them isn't safe.
  // Exit so Render restarts us instead of serving with a broken queue.
  logger.error("Startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

const shutdown = createShutdown({ server, getWorkers: () => workers, disconnect: disconnectDb });
function onSignal(signal: string): void {
  shuttingDown = true; // stops a startup that's still connecting from starting the worker
  void shutdown(signal);
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
