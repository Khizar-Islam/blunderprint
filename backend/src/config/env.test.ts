import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, parseCorsOrigins, parseDemoPlayers, parseTrustProxyHops } from "./env.js";

const VALID_URI = "mongodb+srv://user:pass@example.mongodb.net/blunderprint";
const BASE = { MONGODB_URI: VALID_URI, CONTACT_EMAIL: "dev@example.com" };
const SALT = "x".repeat(32);

test("parseTrustProxyHops accepts whole numbers 0 to 5", () => {
  for (const raw of ["0", "3", "5", " 3 "]) {
    assert.equal(parseTrustProxyHops(raw, () => assert.fail("should not warn")), Number(raw.trim()));
  }
});

test("parseTrustProxyHops treats unset or blank as 0 without warning", () => {
  assert.equal(parseTrustProxyHops(undefined, () => assert.fail("should not warn")), 0);
  assert.equal(parseTrustProxyHops("  ", () => assert.fail("should not warn")), 0);
});

test("parseTrustProxyHops warns and falls back to 0 on invalid values", () => {
  for (const raw of ["-1", "6", "abc", "2.5", "1e1", "true"]) {
    const warnings: string[] = [];
    assert.equal(parseTrustProxyHops(raw, (msg) => warnings.push(msg)), 0, raw);
    assert.equal(warnings.length, 1, raw);
  }
});

test("parseCorsOrigins trims and skips empty entries", () => {
  assert.deepEqual(parseCorsOrigins(" https://a.example.com , ,http://localhost:3001 "), [
    "https://a.example.com",
    "http://localhost:3001",
  ]);
  assert.deepEqual(parseCorsOrigins(undefined), []);
});

test("parseCorsOrigins rejects wildcards, paths and trailing slashes", () => {
  for (const raw of ["*", "https://a.example.com/", "https://a.example.com/app", "a.example.com", "ftp://a.example.com"]) {
    assert.throws(() => parseCorsOrigins(raw), /CORS_ORIGINS/, raw);
  }
});

test("loadEnv fails without MONGODB_URI and names the variable", () => {
  assert.throws(() => loadEnv({}), /MONGODB_URI/);
});

test("loadEnv requires a valid CONTACT_EMAIL", () => {
  assert.throws(() => loadEnv({ MONGODB_URI: VALID_URI }), /CONTACT_EMAIL/);
  assert.throws(() => loadEnv({ ...BASE, CONTACT_EMAIL: "not-an-email" }), /CONTACT_EMAIL/);
});

test("loadEnv does not echo values in its error", () => {
  const secret = "not-a-uri-secret-value";
  assert.throws(
    () => loadEnv({ ...BASE, MONGODB_URI: secret }),
    (err: Error) => err.message.includes("MONGODB_URI") && !err.message.includes(secret),
  );
});

test("loadEnv applies defaults and treats blank values as unset", () => {
  const env = loadEnv({ ...BASE, PORT: "", TRUST_PROXY_HOPS: "" });
  assert.equal(env.PORT, 5000);
  assert.equal(env.GEMINI_MODEL, "gemini-3.5-flash-lite");
  assert.equal(env.AI_ENABLED, true);
  assert.equal(env.AI_DAILY_CALL_BUDGET, 400);
  assert.equal(env.MAX_GAMES_PER_PLAYER, 200);
  assert.equal(env.TRUST_PROXY_HOPS, 0);
  assert.deepEqual(env.corsOrigins, ["http://localhost:3000", "https://blunderprint.vercel.app"]);
  assert.equal(env.isRender, false);
});

test("loadEnv parses booleans, numbers and extra CORS origins", () => {
  const env = loadEnv({
    ...BASE,
    AI_ENABLED: "false",
    PORT: "8080",
    TRUST_PROXY_HOPS: "3",
    CORS_ORIGINS: "https://blunderprint.example.com",
    RENDER: "true",
    IP_HASH_SALT: SALT,
  });
  assert.equal(env.AI_ENABLED, false);
  assert.equal(env.PORT, 8080);
  assert.equal(env.TRUST_PROXY_HOPS, 3);
  assert.deepEqual(env.corsOrigins, [
    "http://localhost:3000",
    "https://blunderprint.vercel.app",
    "https://blunderprint.example.com",
  ]);
  assert.equal(env.isRender, true);
});

test("loadEnv: the coach defaults, and the scripted model only outside production", () => {
  const env = loadEnv(BASE);
  assert.equal(env.COACH_MODEL, "gemini");
  assert.equal(env.COACH_MIN_ANALYSED_GAMES, 20);
  assert.equal(loadEnv({ ...BASE, COACH_MODEL: "scripted" }).COACH_MODEL, "scripted");
  assert.throws(() => loadEnv({ ...BASE, COACH_MODEL: "scripted", NODE_ENV: "production" }), /COACH_MODEL: "scripted" is for local development only/);
  assert.throws(() => loadEnv({ ...BASE, COACH_MODEL: "scripted", RENDER: "true" }), /local development only/);
  assert.throws(() => loadEnv({ ...BASE, COACH_MODEL: "claude" }), /COACH_MODEL/);
  assert.equal(loadEnv({ ...BASE, COACH_MODEL: "scripted", COACH_SCRIPTED_SCENARIO: "overload-switch" }).COACH_SCRIPTED_SCENARIO, "overload-switch");
  assert.throws(() => loadEnv({ ...BASE, COACH_SCRIPTED_SCENARIO: "slow", RENDER: "true" }), /COACH_SCRIPTED_SCENARIO: is for local development only/);
  assert.throws(() => loadEnv({ ...BASE, COACH_SCRIPTED_SCENARIO: "chaos" }), /COACH_SCRIPTED_SCENARIO/);
});

test("loadEnv: the fallback model and the per-run request ceiling", () => {
  const env = loadEnv(BASE);
  assert.equal(env.GEMINI_FALLBACK_MODEL, "gemini-3.1-flash-lite");
  assert.equal(env.COACH_MAX_REQUESTS, 16);
  assert.equal(loadEnv({ ...BASE, GEMINI_FALLBACK_MODEL: "none" }).GEMINI_FALLBACK_MODEL, "none");
  // The ceiling must cover every logical call once (10 + 2).
  assert.throws(() => loadEnv({ ...BASE, COACH_MAX_REQUESTS: "11" }), /COACH_MAX_REQUESTS: must be at least/);
});

test("parseDemoPlayers: platform:username keys, lower-cased, trimmed, without duplicates", () => {
  assert.deepEqual(parseDemoPlayers(undefined), []);
  assert.deepEqual(parseDemoPlayers(" lichess:DrNykterstein , chesscom:Some_Name-1,,lichess:drnykterstein "), [
    "lichess:drnykterstein",
    "chesscom:some_name-1",
  ]);
});

test("parseDemoPlayers: an invalid entry stops startup and names it", () => {
  for (const bad of ["DrNykterstein", "chess:hikaru", "lichess:", "lichess:a b", "lichess:x"]) {
    assert.throws(() => parseDemoPlayers(bad), /DEMO_PLAYERS has an invalid entry/);
  }
});

test("loadEnv: the Stage 6 guard defaults, and the IP hash salt is required in production", () => {
  const env = loadEnv(BASE);
  assert.equal(env.IP_HASH_SALT, undefined); // local development may go without (lib/visitor.ts randomSalt)
  assert.equal(env.LIMIT_IMPORTS_PER_HOUR, 5);
  assert.equal(env.LIMIT_IMPORTS_PER_DAY, 15);
  assert.equal(env.LIMIT_REPORTS_PER_DAY, 3);
  assert.equal(env.LIMIT_REQUESTS_PER_MINUTE, 300);
  assert.equal(env.STORAGE_NEW_PLAYER_LIMIT_MB, 120);
  assert.equal(env.NEW_PLAYERS_PER_DAY, 40);
  assert.equal(env.IMPORT_QUEUE_MAX, 10);
  // Chunk B: questions.
  assert.equal(env.LIMIT_ASKS_PER_HOUR, 6);
  assert.equal(env.LIMIT_ASKS_PER_DAY, 20);
  assert.equal(env.COACH_QUEUE_MAX, 5);
  assert.equal(env.ASK_MAX_MODEL_CALLS, 6);
  assert.equal(env.ASK_MAX_REPAIR_CALLS, 1);
  assert.equal(env.ASK_MAX_REQUESTS, 10);
  assert.equal(env.ASK_RUN_TIMEOUT_MS, 120_000);
  assert.throws(() => loadEnv({ ...BASE, ASK_MAX_REQUESTS: "6" }), /ASK_MAX_REQUESTS: must be at least/);

  assert.throws(() => loadEnv({ ...BASE, RENDER: "true" }), /IP_HASH_SALT: required in production, at least 32 characters/);
  assert.throws(() => loadEnv({ ...BASE, NODE_ENV: "production", IP_HASH_SALT: "x".repeat(31) }), /IP_HASH_SALT/);
  assert.equal(loadEnv({ ...BASE, RENDER: "true", IP_HASH_SALT: SALT }).IP_HASH_SALT, SALT);
  // The error never echoes the value.
  try {
    loadEnv({ ...BASE, RENDER: "true", IP_HASH_SALT: "short-secret-value" });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(!(err as Error).message.includes("short-secret-value"));
  }
  assert.throws(() => loadEnv({ ...BASE, LIMIT_IMPORTS_PER_HOUR: "0" }), /LIMIT_IMPORTS_PER_HOUR/);
});
