import { z } from "zod";
import { logger } from "../lib/logger.js";

// Origins that are always allowed: local dev and the live Vercel production domain.
// Vercel preview URLs are not included; add one temporarily via CORS_ORIGINS if needed.
export const FIXED_CORS_ORIGINS = ["http://localhost:3000", "https://blunderprint.vercel.app"];

const MAX_TRUST_PROXY_HOPS = 5;
const MIN_SALT_LENGTH = 32;

// How many proxies sit in front of us (Render needs 3: visitor → Cloudflare → Render proxy).
// Anything other than a whole number 0–5 is a config mistake: warn and fall back to 0,
// because a too-high value would let visitors fake their IP via X-Forwarded-For.
export function parseTrustProxyHops(
  raw: string | undefined,
  warn: (msg: string) => void = (msg) => logger.warn(msg),
): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || Number(value) > MAX_TRUST_PROXY_HOPS) {
    warn(`TRUST_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUST_PROXY_HOPS}; using 0`);
    return 0;
  }
  return Number(value);
}

// Bare origins only: scheme + host + optional port. No "*", no paths, no trailing slash.
const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

// Extra origins from CORS_ORIGINS (comma-separated). Invalid entries stop startup,
// so a typo shows up in the deploy log instead of as a mysterious CORS error in the browser.
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const origin of origins) {
    if (!ORIGIN_PATTERN.test(origin)) {
      throw new Error(`CORS_ORIGINS has an invalid entry: "${origin}" (expected e.g. https://example.com)`);
    }
  }
  return origins;
}

// DEMO_PLAYERS: comma-separated "platform:username" (e.g. "lichess:DrNykterstein"). Demo players
// are frozen (lib/demo.ts). Returned as "platform:usernamelower" keys. Like CORS_ORIGINS, an
// invalid entry stops startup, so a typo can't silently unfreeze the demo.
const DEMO_ENTRY = /^(chesscom|lichess):([A-Za-z0-9_-]{2,30})$/;
export function parseDemoPlayers(raw: string | undefined): string[] {
  if (!raw) return [];
  const keys = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const match = DEMO_ENTRY.exec(entry);
      if (!match) {
        throw new Error(`DEMO_PLAYERS has an invalid entry: "${entry}" (expected e.g. lichess:DrNykterstein)`);
      }
      return `${match[1]}:${match[2]!.toLowerCase()}`;
    });
  return [...new Set(keys)];
}

const envSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// URI"),
  // Optional until Stage 5 (the coach agent), so the API can boot without them.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  // Used for the rest of a coach run after GEMINI_MODEL is overloaded twice in a row (503).
  // gemini-3.1-flash-lite: Stable, function calling + structured outputs supported (model page,
  // aistudio.google.com/docs, checked 5 Nov 2026); shuts down 7 May 2027 (deprecations page).
  // "none" turns the fallback off.
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-3.1-flash-lite"),
  AI_ENABLED: z.stringbool().default(true),
  AI_DAILY_CALL_BUDGET: z.coerce.number().int().nonnegative().default(400),
  // The model's free-tier limits, from the AI Studio rate-limit page (project "blunderprint",
  // checked 4 Nov 2026: Gemini 3.5 Flash-Lite = 15 RPM, 250K TPM, 500 RPD). Google no longer
  // publishes them in the docs, so they live here, not in code. The pacer (agent/pacer.ts)
  // keeps every model call in the process under RPM and TPM; RPD is what AI_DAILY_CALL_BUDGET
  // must stay under.
  GEMINI_RPM: z.coerce.number().int().positive().default(15),
  GEMINI_TPM: z.coerce.number().int().positive().default(250_000),
  GEMINI_RPD: z.coerce.number().int().positive().default(500),
  // One coach run's limits (agent/loop.ts). Model calls: the investigation and the final
  // answer; the repair round may add COACH_MAX_REPAIR_CALLS more.
  COACH_MAX_MODEL_CALLS: z.coerce.number().int().min(2).max(20).default(10),
  COACH_MAX_REPAIR_CALLS: z.coerce.number().int().min(0).max(4).default(2),
  // A hard ceiling on one run's requests, retries included. Also what a run must have left in
  // the daily budget to start (POST /report).
  COACH_MAX_REQUESTS: z.coerce.number().int().min(4).max(40).default(16),
  COACH_MAX_TOKENS: z.coerce.number().int().positive().default(120_000),
  COACH_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  COACH_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // What counts as a weakness (agent/tools/candidates.ts): at least this much worse than the
  // player's own overall figure for the same measure (relative: 0.15 = 15%), on at least this
  // many games and, for rates per 100 moves, this many of the player's moves.
  COACH_MIN_BASELINE_GAP: z.coerce.number().min(0).max(1).default(0.15),
  COACH_MIN_CANDIDATE_GAMES: z.coerce.number().int().min(2).default(5),
  COACH_MIN_CANDIDATE_MOVES: z.coerce.number().int().min(1).default(100),
  // A report needs this many analysed games (with features) before it can start (POST 409 below it).
  COACH_MIN_ANALYSED_GAMES: z.coerce.number().int().min(1).default(20),
  // "gemini" (the real model) or "scripted" (agent/scriptedModel.ts: no AI calls, for local
  // development only; refused below when running in production).
  COACH_MODEL: z.enum(["gemini", "scripted"]).default("gemini"),
  // What the scripted model plays (local development only, like COACH_MODEL=scripted):
  //   ok              a normal run
  //   overload-switch two 503s, then the run switches to a scripted fallback (slower calls)
  //   fail-overloaded every request is a 503: the run fails with ai_unavailable
  //   slow            a normal run with ~2.5 s per call, to watch the trace
  COACH_SCRIPTED_SCENARIO: z.enum(["ok", "overload-switch", "fail-overloaded", "slow"]).default("ok"),
  // Goes in the User-Agent of every Chess.com / Lichess request, so they can reach us
  // instead of blocking us. Required: the importers must not run without it.
  CONTACT_EMAIL: z.email(),
  MAX_GAMES_PER_PLAYER: z.coerce.number().int().positive().default(200),
  DEMO_PLAYERS: z.string().default(""),
  // Stage 6 guards (CLAUDE.md §10 "Guards"). The secret key of the visitor hash (lib/visitor.ts):
  // required in production (checked below), at least 32 characters; never logged. Changing it
  // starts every visitor's counters from zero.
  IP_HASH_SALT: z.string().optional(),
  // Per visitor (hashed IP). Counted only when the action really starts: a rejoined or
  // up-to-date import, a cached report, a frozen demo player are free.
  LIMIT_IMPORTS_PER_HOUR: z.coerce.number().int().positive().default(5),
  LIMIT_IMPORTS_PER_DAY: z.coerce.number().int().positive().default(15),
  LIMIT_REPORTS_PER_DAY: z.coerce.number().int().positive().default(3),
  // The in-memory flood guard on /api (per visitor, per minute). Generous: a dashboard with the
  // engine running makes a few requests every ten seconds.
  LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(300),
  // Storage: no NEW player is imported once the database's dataSize + indexSize (what Atlas M0's
  // 512 MB counts) reaches this. Players already stored can still refresh.
  STORAGE_NEW_PLAYER_LIMIT_MB: z.coerce.number().positive().default(120),
  // At most this many new players a day (Pacific), across all visitors.
  NEW_PLAYERS_PER_DAY: z.coerce.number().int().positive().default(40),
  // At most this many queued imports: past it, a new import gets 503 busy.
  IMPORT_QUEUE_MAX: z.coerce.number().int().positive().default(10),
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.string().default("development"),
  // Render sets RENDER=true on its services; used only for the trust-proxy warning.
  RENDER: z.string().optional(),
});

export type Env = z.infer<typeof envSchema> & {
  TRUST_PROXY_HOPS: number;
  corsOrigins: string[];
  // DEMO_PLAYERS as "platform:usernamelower" keys (parseDemoPlayers).
  demoPlayers: string[];
  isRender: boolean;
};

// Treat empty strings as "not set", so a blank line in .env falls back to the default.
function withoutEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") result[key] = value;
  }
  return result;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = withoutEmpty(source);
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Only names and rule messages: never echo values, which may be secrets.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join("\n  ")}`);
  }
  // The ceiling must at least allow every logical call once.
  if (parsed.data.COACH_MAX_REQUESTS < parsed.data.COACH_MAX_MODEL_CALLS + parsed.data.COACH_MAX_REPAIR_CALLS) {
    throw new Error("Invalid environment:\n  COACH_MAX_REQUESTS: must be at least COACH_MAX_MODEL_CALLS + COACH_MAX_REPAIR_CALLS");
  }
  // The scripted model fakes the coach: it must never answer real visitors.
  const production = parsed.data.NODE_ENV === "production" || cleaned.RENDER === "true";
  if (parsed.data.COACH_MODEL === "scripted" && production) {
    throw new Error('Invalid environment:\n  COACH_MODEL: "scripted" is for local development only');
  }
  if (parsed.data.COACH_SCRIPTED_SCENARIO !== "ok" && production) {
    throw new Error("Invalid environment:\n  COACH_SCRIPTED_SCENARIO: is for local development only");
  }
  // Without a secret salt the visitor hash could be reversed by hashing every IPv4 address.
  if (production && (parsed.data.IP_HASH_SALT ?? "").length < MIN_SALT_LENGTH) {
    throw new Error(`Invalid environment:\n  IP_HASH_SALT: required in production, at least ${MIN_SALT_LENGTH} characters`);
  }
  // Our own daily budget must leave headroom under Google's: past RPD every call is a 429.
  if (parsed.data.AI_DAILY_CALL_BUDGET > parsed.data.GEMINI_RPD) {
    logger.warn("AI_DAILY_CALL_BUDGET is above GEMINI_RPD: the coach will hit Google's daily limit first", {
      budget: parsed.data.AI_DAILY_CALL_BUDGET,
      rpd: parsed.data.GEMINI_RPD,
    });
  }
  return {
    ...parsed.data,
    TRUST_PROXY_HOPS: parseTrustProxyHops(cleaned.TRUST_PROXY_HOPS),
    corsOrigins: [...FIXED_CORS_ORIGINS, ...parseCorsOrigins(cleaned.CORS_ORIGINS)],
    demoPlayers: parseDemoPlayers(cleaned.DEMO_PLAYERS),
    isRender: cleaned.RENDER === "true",
  };
}
