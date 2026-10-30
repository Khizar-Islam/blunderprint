import { Router } from "express";

export interface HealthDeps {
  getDbStatus: () => boolean;
  version: string;
}

// Always 200: Render's health check uses this route, and a 503 during a short Atlas hiccup
// would make Render restart a perfectly healthy API. The body says what is actually up.
export function healthRouter({ getDbStatus, version }: HealthDeps): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    const db = getDbStatus();
    res.json({ ok: db, db, queueDepth: 0, version });
  });
  return router;
}
