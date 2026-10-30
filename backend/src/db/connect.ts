import mongoose from "mongoose";
import { logger } from "../lib/logger.js";

// readyState 1 = connected (0 disconnected, 2 connecting, 3 disconnecting).
export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

// Log state changes once, without the URI (it contains the password).
mongoose.connection.on("connected", () => logger.info("MongoDB connected", { db: mongoose.connection.name }));
mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
mongoose.connection.on("reconnected", () => logger.info("MongoDB reconnected"));

// Mongoose reconnects by itself after a successful first connect, but not if the
// *first* connect fails, so retry that with backoff (5 s, 10 s, 20 s, then every 30 s).
export async function connectWithRetry(uri: string): Promise<void> {
  let delayMs = 5_000;
  for (;;) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
      return;
    } catch (err) {
      logger.error("MongoDB connection failed, retrying", {
        error: err instanceof Error ? err.message : String(err),
        retryInMs: delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
