import type { Response } from "express";
import type { Env } from "../config/env.js";
import { logger } from "./logger.js";
import type { QuotaRule } from "./quota.js";
import { createStorageGate, type StorageGate } from "./storage.js";
import { createVisitorKey, randomSalt, type VisitorKey } from "./visitor.js";

// The Stage 6 guards in one bundle (CLAUDE.md §10 "Guards"), built once from env in server.ts
// and handed to createApp. Tests build their own with tiny limits; an app created without
// guards (most route tests) has no limits at all.

export interface GuardLimits {
  importsPerHour: number;
  importsPerDay: number;
  reportsPerDay: number;
  asksPerHour: number;
  asksPerDay: number;
  requestsPerMinute: number;
  newPlayersPerDay: number;
  importQueueMax: number;
  coachQueueMax: number;
}

export interface Guards {
  visitorKey: VisitorKey;
  limits: GuardLimits;
  storage: StorageGate;
  now?: () => Date;
}

type GuardEnv = Pick<
  Env,
  | "IP_HASH_SALT"
  | "LIMIT_IMPORTS_PER_HOUR"
  | "LIMIT_IMPORTS_PER_DAY"
  | "LIMIT_REPORTS_PER_DAY"
  | "LIMIT_ASKS_PER_HOUR"
  | "LIMIT_ASKS_PER_DAY"
  | "COACH_QUEUE_MAX"
  | "LIMIT_REQUESTS_PER_MINUTE"
  | "NEW_PLAYERS_PER_DAY"
  | "IMPORT_QUEUE_MAX"
  | "STORAGE_NEW_PLAYER_LIMIT_MB"
>;

export function guardsFromEnv(env: GuardEnv): Guards {
  // config/env.ts refuses to start in production without a salt; locally a random one is fine.
  if (!env.IP_HASH_SALT) logger.warn("IP_HASH_SALT is not set: using a random salt for this process (development only)");
  return {
    visitorKey: createVisitorKey(env.IP_HASH_SALT || randomSalt()),
    limits: {
      importsPerHour: env.LIMIT_IMPORTS_PER_HOUR,
      importsPerDay: env.LIMIT_IMPORTS_PER_DAY,
      reportsPerDay: env.LIMIT_REPORTS_PER_DAY,
      asksPerHour: env.LIMIT_ASKS_PER_HOUR,
      asksPerDay: env.LIMIT_ASKS_PER_DAY,
      requestsPerMinute: env.LIMIT_REQUESTS_PER_MINUTE,
      newPlayersPerDay: env.NEW_PLAYERS_PER_DAY,
      importQueueMax: env.IMPORT_QUEUE_MAX,
      coachQueueMax: env.COACH_QUEUE_MAX,
    },
    storage: createStorageGate({ limitMb: env.STORAGE_NEW_PLAYER_LIMIT_MB }),
  };
}

// The visitor's key, put there by lib/visitor.ts visitorMiddleware.
export const visitorOf = (res: Response): string => String(res.locals.visitor ?? "unknown");

// Counter scopes in the `usage` collection. "ip:" + the hash, never the IP itself.
export const importRules = (visitor: string, limits: GuardLimits): QuotaRule[] => [
  { scope: `ip:${visitor}|imports`, limit: limits.importsPerHour, window: "hour" },
  { scope: `ip:${visitor}|imports`, limit: limits.importsPerDay, window: "day" },
];
export const reportRules = (visitor: string, limits: GuardLimits): QuotaRule[] => [
  { scope: `ip:${visitor}|reports`, limit: limits.reportsPerDay, window: "day" },
];
export const askRules = (visitor: string, limits: GuardLimits): QuotaRule[] => [
  { scope: `ip:${visitor}|asks`, limit: limits.asksPerHour, window: "hour" },
  { scope: `ip:${visitor}|asks`, limit: limits.asksPerDay, window: "day" },
];
export const newPlayerRules = (limits: GuardLimits): QuotaRule[] => [
  { scope: "global:new-players", limit: limits.newPlayersPerDay, window: "day" },
];

// One log line per refusal, so Render's logs show how often each guard fires. Only the first
// 8 characters of the visitor hash: enough to tell visitors apart in a log search.
export function logRefusal(res: Response, guard: string, fields: Record<string, unknown> = {}): void {
  logger.warn(guard === "storage" ? "storage_refused" : "limit_refused", { requestId: res.locals.requestId, guard, visitor: visitorOf(res).slice(0, 8), ...fields });
}
