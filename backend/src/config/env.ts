import { z } from "zod";
import { logger } from "../lib/logger.js";

// Origins that are always allowed. The live Vercel URL is added after the first deploy.
export const FIXED_CORS_ORIGINS = ["http://localhost:3000"];

const MAX_TRUST_PROXY_HOPS = 5;

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

const envSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// URI"),
  // Optional until Stage 5 (the coach agent), so the API can boot without them.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  AI_ENABLED: z.stringbool().default(true),
  AI_DAILY_CALL_BUDGET: z.coerce.number().int().nonnegative().default(400),
  CONTACT_EMAIL: z.string().optional(),
  MAX_GAMES_PER_PLAYER: z.coerce.number().int().positive().default(200),
  DEMO_PLAYERS: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.string().default("development"),
  // Render sets RENDER=true on its services; used only for the trust-proxy warning.
  RENDER: z.string().optional(),
});

export type Env = z.infer<typeof envSchema> & {
  TRUST_PROXY_HOPS: number;
  corsOrigins: string[];
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
  return {
    ...parsed.data,
    TRUST_PROXY_HOPS: parseTrustProxyHops(cleaned.TRUST_PROXY_HOPS),
    corsOrigins: [...FIXED_CORS_ORIGINS, ...parseCorsOrigins(cleaned.CORS_ORIGINS)],
    isRender: cleaned.RENDER === "true",
  };
}
