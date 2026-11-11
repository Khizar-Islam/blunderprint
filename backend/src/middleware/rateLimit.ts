import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { sendFriendly } from "../agent/friendly.js";
import { logRefusal, visitorOf } from "../lib/guards.js";

// The flood guard: at most `perMinute` requests per visitor per minute on /api. It only stops a
// script hammering the API; the real limits (imports, reports) are counted in MongoDB by the
// routes. In memory on purpose: a restart forgetting a minute of counts doesn't matter, and it
// costs no database write per request.
//
// express-rate-limit with:
// - keyGenerator: the visitor hash (lib/visitor.ts), so the in-memory store holds hashes, never
//   IPs, and IPv6 visitors are counted per /64.
// - standardHeaders "draft-8": the RateLimit headers, and Retry-After on a refusal.
// - skip /api/health: Render's health check and the web footer's prewarm poll it, and it's cached.
export function floodGuard(perMinute: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (_req, res) => visitorOf(res),
    skip: (req) => req.path === "/health",
    handler: (_req, res) => {
      logRefusal(res, "requests");
      sendFriendly(res, 429, "limit_requests");
    },
  });
}
