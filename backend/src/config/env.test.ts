import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, parseCorsOrigins, parseTrustProxyHops } from "./env.js";

const VALID_URI = "mongodb+srv://user:pass@example.mongodb.net/blunderprint";

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

test("loadEnv does not echo values in its error", () => {
  const secret = "not-a-uri-secret-value";
  assert.throws(
    () => loadEnv({ MONGODB_URI: secret }),
    (err: Error) => err.message.includes("MONGODB_URI") && !err.message.includes(secret),
  );
});

test("loadEnv applies defaults and treats blank values as unset", () => {
  const env = loadEnv({ MONGODB_URI: VALID_URI, PORT: "", TRUST_PROXY_HOPS: "" });
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
    MONGODB_URI: VALID_URI,
    AI_ENABLED: "false",
    PORT: "8080",
    TRUST_PROXY_HOPS: "3",
    CORS_ORIGINS: "https://blunderprint.example.com",
    RENDER: "true",
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
