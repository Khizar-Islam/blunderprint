import mongoose from "mongoose";
import { AgentRun } from "../db/models/agentRun.js";
import { Job, JOB_TYPES } from "../db/models/job.js";
import { Usage } from "../db/models/usage.js";
import { msUntilPacificMidnight, pacificDay } from "../lib/quota.js";

// `npm run ops:status` (scripts/opsStatus.ts, Stage 6 chunk D): one read-only look at the live
// system. Three parts, kept apart so they can be tested:
//   collectDbStatus  reads the shared database (no write of any kind);
//   fetchLive        reads the live API: /api/health, and GET /report for each demo player
//                    (checked to write nothing for a frozen demo player: its report already has
//                    every ribbon, so withRibbons doesn't save);
//   formatStatus     turns both into the text the script prints.
// Never in the output: the connection string, keys, tokens, or a visitor's hash (counts only).

const MB = 1024 * 1024;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export interface StatusLimits {
  aiDailyCalls: number;
  askMinRequests: number; // ASK_MAX_REQUESTS: POST /ask refuses below this
  reportMinRequests: number; // COACH_MAX_REQUESTS: POST /report refuses below this
  storageGateMb: number;
  atlasMb: number;
  importsPerHour: number;
  importsPerDay: number;
  reportsPerDay: number;
  asksPerHour: number;
  asksPerDay: number;
  newPlayersPerDay: number;
}

export interface DbStatus {
  at: Date;
  ai: { day: string; used: number; scriptedUsed: number; resetsInMs: number };
  storage: { usedMb: number; collections: { name: string; mb: number }[] | null } | null;
  queue: {
    active: { type: string; queued: number; running: number }[];
    oldestQueuedMs: number | null;
    expiredLeases: number;
    failed24h: { type: string; code: string; count: number }[];
  };
  runs24h: { kind: string; status: string; count: number }[];
  capped: { guard: string; visitors: number }[];
  newPlayersToday: number;
}

// Today's visitor counters at their cap, per guard. The counters can't count refusals (a take
// only adds while under the limit), so this is "visitors who reached a limit", not "refusals";
// the exact refusals are Render's `limit_refused` log lines.
const GUARDS: { guard: string; scope: string; window: "hour" | "day"; limit: (l: StatusLimits) => number }[] = [
  { guard: "imports / hour", scope: "imports", window: "hour", limit: (l) => l.importsPerHour },
  { guard: "imports / day", scope: "imports", window: "day", limit: (l) => l.importsPerDay },
  { guard: "reports / day", scope: "reports", window: "day", limit: (l) => l.reportsPerDay },
  { guard: "questions / hour", scope: "asks", window: "hour", limit: (l) => l.asksPerHour },
  { guard: "questions / day", scope: "asks", window: "day", limit: (l) => l.asksPerDay },
];

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function collectDbStatus(limits: StatusLimits, at: Date = new Date()): Promise<DbStatus> {
  const day = pacificDay(at);
  const hour = at.toISOString().slice(0, 13); // the hour window's name (lib/quota.ts)
  const since = new Date(at.getTime() - DAY_MS);

  const [ai, scripted, newPlayers, visitorDocs, active, oldest, expiredLeases, failed, runs, storage] = await Promise.all([
    Usage.findById(`global:ai|${day}`, { count: 1 }).lean(),
    Usage.findById(`dev:scripted|${day}`, { count: 1 }).lean(),
    Usage.findById(`global:new-players|${day}`, { count: 1 }).lean(),
    // Only this hour's and today's visitor counters. Their _id is "ip:<hash>|<scope>|<window>";
    // the hash is read here to split the id and never leaves this function.
    Usage.find({ _id: { $regex: `^ip:[^|]+\\|[a-z]+\\|(${day}|${hour})$` } }, { count: 1 }).lean<{ _id: string; count: number }[]>(),
    Job.aggregate<{ _id: { type: string; status: string }; n: number }>([
      { $match: { status: { $in: ["queued", "running"] } } },
      { $group: { _id: { type: "$type", status: "$status" }, n: { $sum: 1 } } },
    ]),
    Job.findOne({ status: "queued" }, { createdAt: 1 }).sort({ createdAt: 1 }).lean<{ createdAt?: Date }>(),
    Job.countDocuments({ status: "running", leaseUntil: { $lt: at } }),
    Job.aggregate<{ _id: { type: string; code: string | null }; n: number }>([
      { $match: { status: "failed", finishedAt: { $gte: since } } },
      { $group: { _id: { type: "$type", code: "$error.code" }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]),
    AgentRun.aggregate<{ _id: { kind: string; status: string }; n: number }>([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { kind: "$kind", status: "$status" }, n: { $sum: 1 } } },
      { $sort: { "_id.kind": 1, "_id.status": 1 } },
    ]),
    readStorage(),
  ]);

  const capped = GUARDS.map(({ guard, scope, window, limit }) => {
    const name = window === "hour" ? hour : day;
    const visitors = visitorDocs.filter((d) => {
      const [, s, w] = d._id.split("|");
      return s === scope && w === name && d.count >= limit(limits);
    }).length;
    return { guard, visitors };
  });

  return {
    at,
    ai: { day, used: ai?.count ?? 0, scriptedUsed: scripted?.count ?? 0, resetsInMs: msUntilPacificMidnight(at) },
    storage,
    queue: {
      active: JOB_TYPES.map((type) => ({
        type,
        queued: active.find((a) => a._id.type === type && a._id.status === "queued")?.n ?? 0,
        running: active.find((a) => a._id.type === type && a._id.status === "running")?.n ?? 0,
      })),
      oldestQueuedMs: oldest?.createdAt ? at.getTime() - oldest.createdAt.getTime() : null,
      expiredLeases,
      failed24h: failed.map((f) => ({ type: f._id.type, code: f._id.code ?? "(no code)", count: f.n })),
    },
    runs24h: runs.map((r) => ({ kind: r._id.kind ?? "report", status: r._id.status, count: r.n })),
    capped,
    newPlayersToday: newPlayers?.count ?? 0,
  };
}

// dataSize + indexSize: what the storage gate measures and Atlas M0's 512 MB counts
// (lib/storage.ts). Per collection the same two numbers ($collStats). null when unreadable.
async function readStorage(): Promise<DbStatus["storage"]> {
  const db = mongoose.connection.db;
  if (!db) return null;
  try {
    const stats = await db.stats();
    const usedMb = round1((Number(stats.dataSize ?? 0) + Number(stats.indexSize ?? 0)) / MB);
    let collections: { name: string; mb: number }[] | null = null;
    try {
      const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
      collections = (
        await Promise.all(
          names.map(async (name) => {
            const [s] = await db
              .collection(name)
              .aggregate<{ storageStats: { size: number; totalIndexSize: number } }>([{ $collStats: { storageStats: {} } }])
              .toArray();
            return { name, mb: round1(((s?.storageStats.size ?? 0) + (s?.storageStats.totalIndexSize ?? 0)) / MB) };
          }),
        )
      )
        .sort((a, b) => b.mb - a.mb)
        .slice(0, 6);
    } catch {
      collections = null; // $collStats refused: the total is still worth printing
    }
    return { usedMb, collections };
  } catch {
    return null;
  }
}

// ---- The live API -------------------------------------------------------------------------

export interface LiveStatus {
  base: string;
  health: { ok: boolean; db: boolean; version: string; commit: string | null; queueDepth: number | null; storageMb: number | null; storageLimitMb: number | null } | null;
  healthMs: number | null;
  error: string | null;
  demo: { player: string; ai: { enabled: boolean; budgetLeft: number; canStart: boolean } | null; unanswered: string[] | null; error: string | null }[];
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// Read-only GETs. Health first, with a long timeout: a sleeping Render takes up to a minute.
export async function fetchLive(base: string, demoPlayers: string[], fetchImpl: FetchLike = fetch as unknown as FetchLike, now = Date.now): Promise<LiveStatus> {
  const root = base.replace(/\/+$/, "");
  const get = async (path: string, timeoutMs: number) => {
    const res = await fetchImpl(root + path, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const out: LiveStatus = { base: root, health: null, healthMs: null, error: null, demo: [] };
  const started = now();
  try {
    const h = await get("/api/health", 90_000);
    out.healthMs = now() - started;
    out.health = {
      ok: h.ok === true,
      db: h.db === true,
      version: String(h.version ?? "?"),
      commit: typeof h.commit === "string" ? h.commit : null, // null = a deploy from before the field
      queueDepth: typeof h.queueDepth === "number" ? h.queueDepth : null,
      storageMb: typeof h.storageMb === "number" ? h.storageMb : null,
      storageLimitMb: typeof h.storageLimitMb === "number" ? h.storageLimitMb : null,
    };
  } catch (err) {
    out.error = errorText(err);
    return out;
  }
  for (const key of demoPlayers) {
    const [platform, username] = key.split(":");
    try {
      const r = await get(`/api/players/${encodeURIComponent(platform!)}/${encodeURIComponent(username!)}/report`, 30_000);
      const ai = r.ai as { enabled: boolean; budgetLeft: number; canStart: boolean } | undefined;
      const suggestions = ((r.ask as { suggestions?: { question: string; answered: boolean }[] } | undefined)?.suggestions ?? []);
      out.demo.push({
        player: key,
        ai: ai ? { enabled: !!ai.enabled, budgetLeft: Number(ai.budgetLeft), canStart: !!ai.canStart } : null,
        unanswered: suggestions.filter((s) => !s.answered).map((s) => s.question),
        error: null,
      });
    } catch (err) {
      out.demo.push({ player: key, ai: null, unanswered: null, error: errorText(err) });
    }
  }
  return out;
}

const errorText = (err: unknown) => (err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : "failed");

// ---- The text -----------------------------------------------------------------------------

export interface FormatOptions {
  limits: StatusLimits;
  // When the live API couldn't say: the local check (agent/suggestions.ts staleDemoAnswers).
  localStale?: { model: string; stale: { player: string; missing: string[] }[] } | null;
  // How to print a reset time; the script passes the machine's local time.
  clock?: (d: Date) => string;
}

export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function formatStatus(db: DbStatus, live: LiveStatus | null, opts: FormatOptions): string[] {
  const { limits } = opts;
  const clock = opts.clock ?? ((d: Date) => d.toISOString().slice(11, 16) + " UTC");
  const warn: string[] = [];
  const lines: string[] = [];
  const h = (t: string) => lines.push("", t);

  lines.push(`Blunderprint ops status · ${db.at.toISOString().replace("T", " ").slice(0, 16)} UTC`);

  // AI budget
  h("AI budget (Pacific day " + db.ai.day + ")");
  const left = Math.max(0, limits.aiDailyCalls - db.ai.used);
  lines.push(`  used ${db.ai.used} of ${limits.aiDailyCalls} (local .env limit) · ${left} left`);
  const liveAi = live?.demo.find((d) => d.ai)?.ai ?? null;
  if (liveAi) {
    lines.push(`  live API: AI ${liveAi.enabled ? "on" : "OFF"} · ${liveAi.budgetLeft} left · reports ${liveAi.canStart ? "can start" : "can't start"} (needs ${limits.reportMinRequests}) · questions ${liveAi.enabled && liveAi.budgetLeft >= limits.askMinRequests ? "can start" : "can't start"} (needs ${limits.askMinRequests})`);
    if (!liveAi.enabled) warn.push("the live AI is switched off (AI_ENABLED=false)");
    else if (liveAi.budgetLeft < limits.askMinRequests) warn.push("the live budget is below one question: the coach is resting");
  }
  lines.push(`  resets at ${clock(new Date(db.at.getTime() + db.ai.resetsInMs))} (midnight Pacific), in ${duration(db.ai.resetsInMs)}`);
  lines.push(`  local scripted model today: ${db.ai.scriptedUsed} (its own counter, never the real budget)`);

  // Storage
  h("Storage (dataSize + indexSize)");
  if (db.storage) {
    const s = db.storage;
    lines.push(`  ${s.usedMb} MB · new-player gate ${limits.storageGateMb} MB (${Math.round((s.usedMb / limits.storageGateMb) * 100)}%) · Atlas M0 ${limits.atlasMb} MB (${Math.round((s.usedMb / limits.atlasMb) * 100)}%)`);
    if (s.usedMb >= limits.storageGateMb) warn.push("storage is at the new-player gate: new players are refused");
    else if (s.usedMb >= limits.storageGateMb * 0.8) warn.push("storage is above 80% of the new-player gate");
    if (s.collections) lines.push("  biggest: " + s.collections.map((c) => `${c.name} ${c.mb}`).join(" · "));
  } else lines.push("  (dbStats couldn't be read)");
  if (live?.health?.storageMb != null) lines.push(`  live API says ${live.health.storageMb} MB of ${live.health.storageLimitMb} (cached up to 5 min)`);

  // Queue
  h("Queue (queued / running)");
  lines.push("  " + db.queue.active.map((a) => `${a.type} ${a.queued}/${a.running}`).join(" · "));
  lines.push(`  oldest queued: ${db.queue.oldestQueuedMs == null ? "none" : duration(db.queue.oldestQueuedMs) + " ago"} · running with an expired lease: ${db.queue.expiredLeases}`);
  if (db.queue.expiredLeases) warn.push(`${db.queue.expiredLeases} running job(s) with an expired lease (the reaper will requeue them; is the API asleep?)`);
  if (db.queue.oldestQueuedMs != null && db.queue.oldestQueuedMs > 15 * 60_000) warn.push("a job has been queued for over 15 minutes");
  lines.push("  failed in the last 24 h: " + (db.queue.failed24h.length ? db.queue.failed24h.map((f) => `${f.type} ${f.code} ×${f.count}`).join(" · ") : "none"));

  // Coach runs
  h("Coach runs, last 24 h");
  lines.push("  " + (db.runs24h.length ? db.runs24h.map((r) => `${r.kind} ${r.status} ${r.count}`).join(" · ") : "none"));

  // Demo answers
  h("Demo answers (suggested questions)");
  if (live?.demo.length) {
    for (const d of live.demo) {
      if (d.error) lines.push(`  ${d.player}: couldn't read (${d.error})`);
      else if (d.unanswered?.length) {
        lines.push(`  ${d.player}: STALE, not answered: ${d.unanswered.map((q) => `"${q}"`).join(", ")}`);
        warn.push(`demo answers are stale for ${d.player}: run npm run demo:answers (CLAUDE.md §10)`);
      } else lines.push(`  ${d.player}: all answered (live API, Render's model)`);
    }
  } else if (opts.localStale) {
    lines.push(`  (live API not checked: local check with model ${opts.localStale.model}, which may not be Render's)`);
    if (!opts.localStale.stale.length) lines.push("  all answered");
    for (const s of opts.localStale.stale) lines.push(`  ${s.player}: not answered: ${s.missing.map((q) => `"${q}"`).join(", ")}`);
  } else lines.push("  (not checked)");

  // Guards
  h("Guards today (visitors at their cap; refusals themselves are only in Render's logs)");
  lines.push("  " + db.capped.map((c) => `${c.guard} ${c.visitors}`).join(" · "));
  lines.push(`  new players today: ${db.newPlayersToday} of ${limits.newPlayersPerDay}`);
  lines.push("  exact refusals: Render → Logs, search limit_refused / storage_refused");
  if (db.newPlayersToday >= limits.newPlayersPerDay) warn.push("the new-player cap is reached for today");

  // Deploy
  h("Live API");
  if (!live) lines.push("  (not checked: pass the API address, npm run ops:status -- https://<api>)");
  else if (live.error) {
    lines.push(`  ${live.base}: unreachable (${live.error})`);
    warn.push("the live API didn't answer /api/health");
  } else if (live.health) {
    const hh = live.health;
    lines.push(`  ${live.base} · ok ${hh.ok} · db ${hh.db} · queue ${hh.queueDepth ?? "?"} · answered in ${((live.healthMs ?? 0) / 1000).toFixed(1)} s`);
    lines.push(`  version ${hh.version} · commit ${hh.commit ?? "(not reported: deployed before the commit field)"}`);
    if (!hh.db) warn.push("the live API has no database connection");
  }

  h(warn.length ? "Needs attention" : "Nothing needs attention");
  for (const w of warn) lines.push("  ! " + w);
  return lines;
}
