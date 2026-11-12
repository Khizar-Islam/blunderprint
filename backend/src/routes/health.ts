import { Router } from "express";
import type { StorageGate } from "../lib/storage.js";

export interface HealthDeps {
  getDbStatus: () => boolean;
  getQueueDepth: () => Promise<number>;
  version: string;
  // The deploy's short commit (lib/version.ts COMMIT), "dev" locally.
  commit?: string;
  cacheMs?: number;
  now?: () => number;
  // The storage gate (lib/storage.ts): its own 5-minute cache, so this costs no extra reads.
  storage?: Pick<StorageGate, "usedMb" | "limitMb">;
}

// Always 200: Render's health check uses this route, and a 503 during a short Atlas hiccup
// would make Render restart a perfectly healthy API. The body says what is actually up.
export function healthRouter({ getDbStatus, getQueueDepth, version, commit = "dev", cacheMs = 5_000, now = Date.now, storage }: HealthDeps): Router {
  const router = Router();

  // Health is polled often (Render, uptime pings, the web app), so the count query runs at most
  // once per cacheMs. Caching the promise means simultaneous requests share one query.
  let cached: { at: number; depth: Promise<number | null> } | null = null;
  function queueDepth(): Promise<number | null> {
    if (!cached || now() - cached.at >= cacheMs) {
      cached = { at: now(), depth: getQueueDepth().catch(() => null) };
    }
    return cached.depth;
  }

  router.get("/health", async (_req, res) => {
    const db = getDbStatus();
    // DB down: don't queue a count behind Mongoose's reconnect, just say we don't know.
    const [depth, storageMb] = db ? await Promise.all([queueDepth(), storage?.usedMb() ?? null]) : [null, null];
    res.json({
      ok: db,
      db,
      queueDepth: depth,
      version,
      commit,
      // dataSize + indexSize in MB, and the size at which new players stop being imported.
      ...(storage ? { storageMb, storageLimitMb: storage.limitMb } : {}),
    });
  });
  return router;
}
