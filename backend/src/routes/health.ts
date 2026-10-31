import { Router } from "express";

export interface HealthDeps {
  getDbStatus: () => boolean;
  getQueueDepth: () => Promise<number>;
  version: string;
  cacheMs?: number;
  now?: () => number;
}

// Always 200: Render's health check uses this route, and a 503 during a short Atlas hiccup
// would make Render restart a perfectly healthy API. The body says what is actually up.
export function healthRouter({ getDbStatus, getQueueDepth, version, cacheMs = 5_000, now = Date.now }: HealthDeps): Router {
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
    res.json({ ok: db, db, queueDepth: db ? await queueDepth() : null, version });
  });
  return router;
}
