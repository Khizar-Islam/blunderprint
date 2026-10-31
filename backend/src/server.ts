import { createApp } from "./app.js";
import { loadEnv, type Env } from "./config/env.js";
import { connectWithRetry, disconnectDb, isDbConnected } from "./db/connect.js";
import { Game } from "./db/models/game.js";
import { Job } from "./db/models/job.js";
import { Player } from "./db/models/player.js";
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

const { queue, handlers } = createJobSystem(env);

const app = createApp({
  corsOrigins: env.corsOrigins,
  trustProxyHops: env.TRUST_PROXY_HOPS,
  getDbStatus: isDbConnected,
  queue,
  version: VERSION,
});

// Startup order: listen → connect → indexes → worker.
// Listen first: /api/health answers (db:false) while Atlas is still connecting, so Render
// sees a live service during a slow cold start.
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on :${env.PORT}`, { version: VERSION, corsOrigins: env.corsOrigins });
});

let worker: Worker | null = null;
let shuttingDown = false;

void (async () => {
  await connectWithRetry(env.MONGODB_URI);
  if (shuttingDown) return;
  // Build any missing indexes before the worker runs: the job queue's idempotency relies on the
  // unique partial index on jobs.key, and imports rely on the unique { playerId, sourceId }.
  // Already-built indexes make this a quick no-op.
  await Promise.all([Player.init(), Game.init(), Job.init()]);
  if (shuttingDown) return;
  // Expired leases from a previous run (crash, Render sleep) are reaped on the first loop turn.
  worker = startWorker({ queue, handlers });
})().catch((err: unknown) => {
  // Reaching here means the indexes couldn't be built: running without them isn't safe.
  // Exit so Render restarts us instead of serving with a broken queue.
  logger.error("Startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

const shutdown = createShutdown({ server, getWorker: () => worker, disconnect: disconnectDb });
function onSignal(signal: string): void {
  shuttingDown = true; // stops a startup that's still connecting from starting the worker
  void shutdown(signal);
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
