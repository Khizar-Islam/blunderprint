import mongoose from "mongoose";
import { errorMessage, logger, withoutLogContext } from "../lib/logger.js";

// readyState 1 = connected (0 disconnected, 2 connecting, 3 disconnecting).
export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

// Log state changes once, without the URI (it contains the password).
// withoutLogContext: these events are about the connection, not about whichever job is running.
// The pool opens sockets on demand, so one can be created (and later fail) inside a job's log
// context, and the line would wrongly carry that job's id.
const onConnection = (event: string, log: (arg: unknown) => void) =>
  mongoose.connection.on(event, (arg: unknown) => withoutLogContext(() => log(arg)));
onConnection("connected", () => logger.info("mongo_connected", { db: mongoose.connection.name }));
onConnection("disconnected", () => logger.warn("mongo_disconnected"));
onConnection("reconnected", () => logger.info("mongo_reconnected"));
// Without an "error" listener, a connection error after the first connect is an unhandled
// "error" event: Node prints a raw stack and the process dies. Mongoose reconnects by itself.
onConnection("error", (err) => logger.error("mongo_error", { error: errorMessage(err) }));

// Mongoose reconnects by itself after a successful first connect, but not if the
// *first* connect fails, so retry that with backoff (5 s, 10 s, 20 s, then every 30 s).
export async function connectWithRetry(uri: string): Promise<void> {
  let delayMs = 5_000;
  for (;;) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
      return;
    } catch (err) {
      logger.error("mongo_connect_failed", {
        error: errorMessage(err),
        waitMs: delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
