import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { AgentRun } from "../db/models/agentRun.js";
import { Job } from "../db/models/job.js";
import { Usage } from "../db/models/usage.js";
import { pacificDay } from "../lib/quota.js";
import { collectDbStatus, duration, fetchLive, formatStatus, type DbStatus, type LiveStatus, type StatusLimits } from "./status.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

const limits: StatusLimits = {
  aiDailyCalls: 400,
  askMinRequests: 10,
  reportMinRequests: 16,
  storageGateMb: 120,
  atlasMb: 512,
  importsPerHour: 5,
  importsPerDay: 15,
  reportsPerDay: 3,
  asksPerHour: 6,
  asksPerDay: 20,
  newPlayersPerDay: 40,
};

// 20:00 UTC on 12 Nov 2026 = 12:00 Pacific (PST, UTC-8): 12 h to the reset.
const AT = new Date("2026-11-12T20:00:00Z");
const DAY = pacificDay(AT); // "2026-11-12"
const HOUR = "2026-11-12T20";
const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const expires = new Date(AT.getTime() + 3 * 86_400_000);

test("collectDbStatus: budget, queue, failures, runs and visitors at their cap, from the database only", async () => {
  const pid = new Types.ObjectId();
  await Usage.create([
    { _id: `global:ai|${DAY}`, count: 37, expiresAt: expires },
    { _id: `dev:scripted|${DAY}`, count: 4, expiresAt: expires },
    { _id: "global:ai|2026-11-11", count: 300, expiresAt: expires }, // yesterday: not counted
    { _id: `global:new-players|${DAY}`, count: 3, expiresAt: expires },
    { _id: `ip:${HASH}|asks|${HOUR}`, count: 6, expiresAt: expires }, // at the hourly cap
    { _id: `ip:${HASH}|asks|${DAY}`, count: 6, expiresAt: expires }, // under the daily cap
    { _id: `ip:ffff${HASH.slice(4)}|imports|${DAY}`, count: 15, expiresAt: expires }, // at the daily cap
    { _id: `ip:${HASH}|imports|2026-11-12T19`, count: 5, expiresAt: expires }, // last hour: not counted
    { _id: `ip:${HASH}|reports|${DAY}`, count: 3, expiresAt: expires },
  ]);
  const job = (o: Record<string, unknown>) => ({ key: `k${Math.random()}`, runAfter: AT, payload: {}, ...o });
  await Job.create([
    job({ type: "import", status: "queued", createdAt: new Date(AT.getTime() - 20 * 60_000) }),
    job({ type: "import", status: "queued", createdAt: new Date(AT.getTime() - 60_000) }),
    job({ type: "ask", status: "running", leaseUntil: new Date(AT.getTime() - 1000) }), // expired lease
    job({ type: "extract", status: "running", leaseUntil: new Date(AT.getTime() + 60_000) }),
    job({ type: "ask", status: "failed", finishedAt: new Date(AT.getTime() - HOURS(2)), error: { code: "coach_timeout", message: "m" } }),
    job({ type: "ask", status: "failed", finishedAt: new Date(AT.getTime() - HOURS(3)), error: { code: "coach_timeout", message: "m" } }),
    job({ type: "import", status: "failed", finishedAt: new Date(AT.getTime() - HOURS(30)), error: { code: "x", message: "m" } }), // older than 24 h
    job({ type: "report", status: "done", finishedAt: new Date(AT.getTime() - HOURS(1)) }),
  ]);
  await AgentRun.create([
    { playerId: pid, model: "m", promptVersion: 6, kind: "ask", status: "done", createdAt: new Date(AT.getTime() - HOURS(1)) },
    { playerId: pid, model: "m", promptVersion: 6, kind: "ask", status: "done", createdAt: new Date(AT.getTime() - HOURS(2)) },
    { playerId: pid, model: "m", promptVersion: 6, kind: "report", status: "failed", createdAt: new Date(AT.getTime() - HOURS(5)) },
    { playerId: pid, model: "m", promptVersion: 6, kind: "report", status: "done", createdAt: new Date(AT.getTime() - HOURS(40)) }, // too old
  ]);

  const s = await collectDbStatus(limits, AT);
  assert.deepEqual(s.ai, { day: DAY, used: 37, scriptedUsed: 4, resetsInMs: HOURS(12) });
  assert.deepEqual(s.queue.active, [
    { type: "import", queued: 2, running: 0 },
    { type: "extract", queued: 0, running: 1 },
    { type: "report", queued: 0, running: 0 },
    { type: "ask", queued: 0, running: 1 },
  ]);
  assert.equal(s.queue.oldestQueuedMs, 20 * 60_000);
  assert.equal(s.queue.expiredLeases, 1);
  assert.deepEqual(s.queue.failed24h, [{ type: "ask", code: "coach_timeout", count: 2 }]);
  assert.deepEqual(s.runs24h, [
    { kind: "ask", status: "done", count: 2 },
    { kind: "report", status: "failed", count: 1 },
  ]);
  assert.deepEqual(s.capped, [
    { guard: "imports / hour", visitors: 0 },
    { guard: "imports / day", visitors: 1 },
    { guard: "reports / day", visitors: 1 },
    { guard: "questions / hour", visitors: 1 },
    { guard: "questions / day", visitors: 0 },
  ]);
  assert.equal(s.newPlayersToday, 3);
  assert.ok(s.storage && s.storage.usedMb >= 0, "dbStats read");
});

function HOURS(n: number) {
  return n * 3_600_000;
}

test("collectDbStatus on an empty database: zeros, no queue, nothing failed", async () => {
  const s = await collectDbStatus(limits, AT);
  assert.equal(s.ai.used, 0);
  assert.equal(s.queue.oldestQueuedMs, null);
  assert.deepEqual(s.queue.failed24h, []);
  assert.deepEqual(s.runs24h, []);
  assert.ok(s.capped.every((c) => c.visitors === 0));
});

// ---- fetchLive ----------------------------------------------------------------------------

function fakeFetch(routes: Record<string, unknown | Error>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const body = routes[url];
    if (body instanceof Error) throw body;
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { impl, calls };
}

test("fetchLive: health, then GET /report per demo player, and nothing else", async () => {
  const { impl, calls } = fakeFetch({
    "https://api.example/api/health": { ok: true, db: true, queueDepth: 0, version: "0.1.0", commit: "84ab56e", storageMb: 61.2, storageLimitMb: 120 },
    "https://api.example/api/players/lichess/drnykterstein/report": {
      ai: { enabled: true, budgetLeft: 350, canStart: true },
      ask: { suggestions: [{ question: "a", answered: true }, { question: "b", answered: false }] },
    },
  });
  const live = await fetchLive("https://api.example/", ["lichess:drnykterstein"], impl);
  assert.deepEqual(calls, ["https://api.example/api/health", "https://api.example/api/players/lichess/drnykterstein/report"]);
  assert.equal(live.health?.commit, "84ab56e");
  assert.deepEqual(live.demo, [{ player: "lichess:drnykterstein", ai: { enabled: true, budgetLeft: 350, canStart: true }, unanswered: ["b"], error: null }]);
});

test("fetchLive: an unreachable API stops at health; an old deploy has no commit", async () => {
  const down = await fetchLive("https://api.example", ["lichess:x"], fakeFetch({ "https://api.example/api/health": new Error("ECONNREFUSED") }).impl);
  assert.equal(down.error, "ECONNREFUSED");
  assert.deepEqual(down.demo, []);
  const old = await fetchLive("https://api.example", [], fakeFetch({ "https://api.example/api/health": { ok: true, db: true, version: "0.1.0" } }).impl);
  assert.equal(old.health?.commit, null);
});

// ---- formatStatus -------------------------------------------------------------------------

const base: DbStatus = {
  at: AT,
  ai: { day: DAY, used: 37, scriptedUsed: 0, resetsInMs: HOURS(12) },
  storage: { usedMb: 61.2, collections: [{ name: "games", mb: 40.1 }] },
  queue: { active: [{ type: "import", queued: 0, running: 0 }], oldestQueuedMs: null, expiredLeases: 0, failed24h: [] },
  runs24h: [{ kind: "ask", status: "done", count: 3 }],
  capped: [{ guard: "questions / hour", visitors: 0 }],
  newPlayersToday: 0,
};
const liveOk: LiveStatus = {
  base: "https://api.example",
  health: { ok: true, db: true, version: "0.1.0", commit: "84ab56e", queueDepth: 0, storageMb: 61.2, storageLimitMb: 120 },
  healthMs: 1200,
  error: null,
  demo: [{ player: "lichess:drnykterstein", ai: { enabled: true, budgetLeft: 363, canStart: true }, unanswered: [], error: null }],
};

test("formatStatus: all well → the figures and 'Nothing needs attention'", () => {
  const text = formatStatus(base, liveOk, { limits }).join("\n");
  assert.match(text, /used 37 of 400 \(local \.env limit\) · 363 left/);
  assert.match(text, /live API: AI on · 363 left/);
  assert.match(text, /resets at 08:00 UTC \(midnight Pacific\), in 12 h/);
  assert.match(text, /61\.2 MB · new-player gate 120 MB \(51%\) · Atlas M0 512 MB \(12%\)/);
  assert.match(text, /lichess:drnykterstein: all answered/);
  assert.match(text, /commit 84ab56e/);
  assert.match(text, /Nothing needs attention/);
});

test("formatStatus: each problem is listed under 'Needs attention'", () => {
  const db: DbStatus = {
    ...base,
    storage: { usedMb: 110, collections: null },
    queue: { ...base.queue, expiredLeases: 2, oldestQueuedMs: 20 * 60_000 },
    newPlayersToday: 40,
  };
  const live: LiveStatus = {
    ...liveOk,
    health: { ...liveOk.health!, db: false },
    demo: [{ player: "lichess:drnykterstein", ai: { enabled: false, budgetLeft: 0, canStart: false }, unanswered: ["Do I play worse with Black?"], error: null }],
  };
  const text = formatStatus(db, live, { limits }).join("\n");
  for (const w of [
    "the live AI is switched off",
    "storage is above 80% of the new-player gate",
    "2 running job(s) with an expired lease",
    "a job has been queued for over 15 minutes",
    "demo answers are stale for lichess:drnykterstein",
    "the new-player cap is reached",
    "the live API has no database connection",
  ])
    assert.ok(text.includes("! " + w), w);
  assert.match(text, /STALE, not answered: "Do I play worse with Black\?"/);
});

test("formatStatus: a budget under one question says the coach is resting; no live API → the local check, labelled", () => {
  const resting = formatStatus(base, { ...liveOk, demo: [{ ...liveOk.demo[0]!, ai: { enabled: true, budgetLeft: 1, canStart: false } }] }, { limits }).join("\n");
  assert.match(resting, /questions can't start \(needs 10\)/);
  assert.match(resting, /! the live budget is below one question/);
  const local = formatStatus(base, null, { limits, localStale: { model: "m-1", stale: [] } }).join("\n");
  assert.match(local, /live API not checked: local check with model m-1/);
  assert.match(local, /not checked: pass the API address/);
});

test("formatStatus never prints a visitor hash", () => {
  const text = formatStatus(base, liveOk, { limits }).join("\n");
  assert.ok(!/ip:|[0-9a-f]{32}/.test(text));
});

test("duration", () => {
  assert.equal(duration(59_000), "1 min");
  assert.equal(duration(HOURS(12)), "12 h");
  assert.equal(duration(HOURS(5) + 12 * 60_000), "5 h 12 min");
});
