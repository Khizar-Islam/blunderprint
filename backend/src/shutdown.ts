import type { Server } from "node:http";
import type { Worker } from "./jobs/worker.js";
import { logger } from "./lib/logger.js";
import { closeAllSse } from "./lib/sse.js";

export interface ShutdownDeps {
  server: Server;
  // A getter: the worker only exists once the DB is connected, which may be after a signal.
  getWorker: () => Worker | null;
  disconnect: () => Promise<void>;
  forceExitMs?: number;
  // How long in-flight requests get to finish before their connections are cut.
  drainMs?: number;
  // Injected so tests can check the exit code without ending the test process.
  exit?: (code: number) => void;
}

// Graceful shutdown. Render sends SIGTERM on redeploy and waits 30 s before SIGKILL
// (render.com/docs/deploys); Ctrl+C sends SIGINT locally. We give ourselves 10 s by default.
export function createShutdown({
  server,
  getWorker,
  disconnect,
  forceExitMs = 10_000,
  drainMs = 2_000,
  exit = process.exit,
}: ShutdownDeps) {
  let started = false;

  return async function shutdown(signal: string): Promise<void> {
    if (started) return; // a second Ctrl+C while we're already stopping
    started = true;
    const t0 = Date.now();
    logger.info("Shutting down", { signal });
    const force = setTimeout(() => {
      logger.error("Shutdown took too long, forcing exit", { ms: Date.now() - t0 });
      exit(1);
    }, forceExitMs);
    force.unref();

    // 1. Stop accepting new connections. close() only calls back once every open connection
    //    has ended, so we wait for it last, after the SSE streams are closed by hand.
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    // 2. Stop the worker: it aborts the running job and releases it back to the queue (attempt
    //    refunded), so the next process picks it up at once instead of waiting out the lease.
    //    This happens before the streams close, so viewers still get the "retrying" event.
    await getWorker()?.stop();
    // 3. End the SSE streams. EventSource reconnects after 3 s, which on Render reaches the
    //    new instance, and its first message is a fresh snapshot.
    const sseClosed = closeAllSse();
    // A client's socket can stay open (keep-alive) after its response ends, and close() waits
    // for every socket. Give in-flight requests drainMs, then cut whatever is left.
    server.closeIdleConnections();
    const drain = setTimeout(() => server.closeAllConnections(), drainMs);
    await serverClosed;
    clearTimeout(drain);
    // 4. Only now close the DB: the release above needed it.
    await disconnect();
    clearTimeout(force);
    logger.info("Shutdown complete", { signal, sseClosed, ms: Date.now() - t0 });
    exit(0);
  };
}
