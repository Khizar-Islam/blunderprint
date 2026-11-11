import { Usage } from "../db/models/usage.js";

// Counters with a limit per time window, kept in MongoDB (the `usage` collection), so every
// limit holds across restarts and Render's sleeps. Used by the AI budget (agent/budget.ts:
// "global:ai", one Pacific day) and the per-visitor limits (Stage 6: "ip:<hash>|imports" per hour
// and per day, ...).
//
// Fixed windows: an hour window is a clock hour (14:00–15:00 UTC), a day window a Pacific-time
// date (Google's daily quota resets at midnight Pacific, so all our days do too). Simpler than a
// sliding window and good enough here: at worst a visitor gets two windows' worth around a
// boundary.
//
// One document per scope and window:  _id "ip:3f2a…|imports|2026-11-11T14" → { count: 2 }

export type QuotaWindow = "hour" | "day";

const PACIFIC = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
// How long a counter is kept after its window ends (TTL index on expiresAt), to look back a little.
const KEEP_AFTER: Record<QuotaWindow, number> = { hour: HOUR_MS, day: 3 * DAY_MS };
const DUPLICATE_KEY = 11000;

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: PACIFIC, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

// "2026-11-05": the Pacific date at this instant ("en-CA" formats dates as YYYY-MM-DD).
export const pacificDay = (at: Date): string => dayFormat.format(at);

// Milliseconds until the next Pacific midnight. A first guess from the wall clock (24 h minus
// the time of day) is exact on normal days; on the two DST change days the day is 23 or 25 h
// long, so the real midnight is the guess or one hour either side: take the first of those at
// which the date has changed.
export function msUntilPacificMidnight(at: Date): number {
  const [h, m, s] = timeFormat.format(at).split(":").map(Number) as [number, number, number];
  const guess = at.getTime() + DAY_MS - ((h * 60 + m) * 60 + s) * 1000 - at.getMilliseconds();
  const today = pacificDay(at);
  for (const t of [guess - HOUR_MS, guess, guess + HOUR_MS]) {
    if (pacificDay(new Date(t)) !== today && pacificDay(new Date(t - 1)) === today) return t - at.getTime();
  }
  return guess - at.getTime();
}

const msUntilNextHour = (at: Date): number => HOUR_MS - (at.getTime() % HOUR_MS);

// The window's name inside the _id, and how long until it ends.
function windowOf(window: QuotaWindow, at: Date): { name: string; endsInMs: number } {
  if (window === "day") return { name: pacificDay(at), endsInMs: msUntilPacificMidnight(at) };
  return { name: at.toISOString().slice(0, 13), endsInMs: msUntilNextHour(at) }; // "2026-11-11T14"
}

export const quotaId = (scope: string, window: QuotaWindow, at: Date): string => `${scope}|${windowOf(window, at).name}`;

export interface QuotaRule {
  scope: string;
  limit: number;
  window: QuotaWindow;
}

// What a successful take() used: give it back with refund() if the action then doesn't happen.
export interface Taken {
  ids: string[];
}

export type TakeResult = { ok: true; taken: Taken } | { ok: false; rule: QuotaRule; retryAfterMs: number };

// Takes one from a single counter, atomically. true = taken, false = the window is at its limit.
//
// One findOneAndUpdate: "the window's document, if its count is still under the limit: +1".
// With upsert, a missing document is created with count 1. When the filter matches nothing
// because the document exists but is AT the limit, the upsert tries to insert a second document
// with the same _id and gets duplicate-key error 11000.
//
// But 11000 has a second cause: at the start of a window two requests can both find no document
// and both insert; one wins and the other gets 11000 although the counter is almost untouched.
// So on 11000 we try ONCE more: by then the document exists, the upsert can't race any more, and
// a second miss really means the limit is reached.
export async function takeOne(rule: QuotaRule, at: Date): Promise<boolean> {
  if (rule.limit <= 0) return false; // an insert would make count 1
  const { name, endsInMs } = windowOf(rule.window, at);
  const _id = `${rule.scope}|${name}`;
  const expiresAt = new Date(at.getTime() + endsInMs + KEEP_AFTER[rule.window]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await Usage.findOneAndUpdate(
        { _id, count: { $lt: rule.limit } },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, returnDocument: "after" },
      );
      return true;
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
    }
  }
  return false;
}

// Gives back what take() used (the action it was for didn't happen: the enqueue failed, or
// someone else's identical job was already running). Never below 0.
export async function refund(taken: Taken): Promise<void> {
  await Promise.all(taken.ids.map((_id) => Usage.updateOne({ _id, count: { $gt: 0 } }, { $inc: { count: -1 } })));
}

// Takes one from EVERY rule (e.g. imports: 5 an hour AND 15 a day), or from none: if a later
// rule refuses, the earlier ones are refunded. The refusal says which rule and how long until
// its window ends (for Retry-After).
export async function take(rules: QuotaRule[], at: Date = new Date()): Promise<TakeResult> {
  const ids: string[] = [];
  for (const rule of rules) {
    let ok: boolean;
    try {
      ok = await takeOne(rule, at);
    } catch (err) {
      await refund({ ids }).catch(() => {}); // the DB error is the one worth reporting
      throw err;
    }
    if (!ok) {
      await refund({ ids });
      return { ok: false, rule, retryAfterMs: windowOf(rule.window, at).endsInMs };
    }
    ids.push(quotaId(rule.scope, rule.window, at));
  }
  return { ok: true, taken: { ids } };
}

// How many are left in the rule's current window (no write).
export async function remaining(rule: QuotaRule, at: Date = new Date()): Promise<number> {
  const doc = await Usage.findById(quotaId(rule.scope, rule.window, at), { count: 1 }).lean();
  return Math.max(0, rule.limit - (doc?.count ?? 0));
}
