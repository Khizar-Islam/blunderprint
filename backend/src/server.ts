import { createApp } from "./app.js";
import { loadEnv, type Env } from "./config/env.js";
import { connectWithRetry, disconnectDb, isDbConnected } from "./db/connect.js";
import { logger } from "./lib/logger.js";
import { VERSION } from "./lib/version.js";

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

const app = createApp({
  corsOrigins: env.corsOrigins,
  trustProxyHops: env.TRUST_PROXY_HOPS,
  getDbStatus: isDbConnected,
  version: VERSION,
});

// Listen first, then connect: /api/health answers (db:false) while Atlas is still connecting.
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on :${env.PORT}`, { version: VERSION, corsOrigins: env.corsOrigins });
});
void connectWithRetry(env.MONGODB_URI);

// Render sends SIGTERM on redeploy; Ctrl+C sends SIGINT locally.
async function shutdown(signal: string): Promise<void> {
  logger.info("Shutting down", { signal });
  server.close();
  await disconnectDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
