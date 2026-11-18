import { errorMessage, logger } from "./logger.js";

// The last line of defence: errors nothing caught. Without these handlers Node prints a raw
// multi-line stack (not our one-line JSON) and exits on the spot: a running job keeps its lease
// until it expires, and open SSE streams are simply cut.
//
// What we do instead: log ONE line, then run the normal graceful shutdown (src/shutdown.ts) with
// exit code 1, so the job goes back to the queue at once and Render restarts the service.
// We do not try to keep serving: after an uncaught exception the process may be in a broken
// state (Node's own advice), and for an unhandled promise rejection Node's default is to exit too.
export interface ProcessErrorDeps {
  shutdown: (reason: string, code: number) => Promise<void>;
  // The HTTP server (only its "error" event is used).
  server: { on(event: "error", listener: (err: unknown) => void): unknown };
  // Injected in tests (a plain EventEmitter and a fake exit).
  proc?: Pick<NodeJS.Process, "on">;
  exit?: (code: number) => void;
}

export function installProcessErrorHandlers({ shutdown, server, proc = process, exit = process.exit }: ProcessErrorDeps): void {
  const stop = (reason: string) => {
    // If the shutdown itself fails, there is nothing left to tidy: exit.
    shutdown(reason, 1).catch((err: unknown) => {
      logger.error("shutdown_failed", { reason, error: errorMessage(err) });
      exit(1);
    });
  };

  // A promise was rejected and nothing handled it (a forgotten await or .catch).
  proc.on("unhandledRejection", (reason: unknown) => {
    logger.error("unhandled_rejection", { error: errorMessage(reason), stack: reason instanceof Error ? reason.stack : undefined });
    stop("unhandledRejection");
  });

  // An error was thrown outside any try/catch or promise (e.g. inside a timer or event callback).
  proc.on("uncaughtException", (err: unknown) => {
    logger.error("uncaught_exception", { error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined });
    stop("uncaughtException");
  });

  // The HTTP server itself failed, typically at startup: the port is taken (EADDRINUSE). There
  // is nothing to shut down gracefully yet, so log and exit.
  server.on("error", (err: unknown) => {
    logger.error("server_error", { error: errorMessage(err), code: (err as NodeJS.ErrnoException | undefined)?.code });
    exit(1);
  });
}
