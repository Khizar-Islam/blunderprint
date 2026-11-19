import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apiOrigin, contentSecurityPolicy, securityHeaders } from "./securityHeaders";

const API = "https://blunderprint-api.onrender.com";
const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((d) => d.startsWith(name + " "))
    ?.slice(name.length + 1);

describe("apiOrigin", () => {
  test("only the origin of the API URL, whatever path or slash it carries", () => {
    assert.equal(apiOrigin(API), API);
    assert.equal(apiOrigin(API + "/"), API);
    assert.equal(apiOrigin(API + "/api"), API);
    assert.equal(apiOrigin("http://localhost:5000"), "http://localhost:5000");
  });
  test("unset or unreadable means no extra origin", () => {
    assert.equal(apiOrigin(undefined), null);
    assert.equal(apiOrigin(""), null);
    assert.equal(apiOrigin("not a url"), null);
    assert.equal(apiOrigin("javascript:alert(1)"), null);
  });
});

describe("contentSecurityPolicy", () => {
  const policy = contentSecurityPolicy(API, false);
  test("the exact production policy", () => {
    assert.equal(
      policy,
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://blunderprint-api.onrender.com; " +
        "worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
        "upgrade-insecure-requests",
    );
  });
  test("http requests are upgraded in production, not in development (localhost is plain http)", () => {
    assert.ok(policy.split("; ").includes("upgrade-insecure-requests"));
    assert.ok(!contentSecurityPolicy("http://localhost:5000", true).includes("upgrade-insecure-requests"));
  });
  test("the page may connect to itself and the API, nowhere else", () => {
    assert.equal(directive(policy, "connect-src"), `'self' ${API}`);
    assert.equal(directive(contentSecurityPolicy(undefined, false), "connect-src"), "'self'");
  });
  test("eval is allowed in development only; WebAssembly always (the engine)", () => {
    assert.ok(!policy.includes("'unsafe-eval'"));
    assert.ok(directive(policy, "script-src")?.includes("'wasm-unsafe-eval'"));
    assert.ok(directive(contentSecurityPolicy(API, true), "script-src")?.split(" ").includes("'unsafe-eval'"));
  });
  test("no wildcard and no whole-scheme source anywhere", () => {
    const sources = policy.split("; ").flatMap((d) => d.split(" ").slice(1));
    assert.ok(!sources.includes("*"));
    assert.ok(!sources.includes("https:") && !sources.includes("http:"));
  });
});

describe("securityHeaders", () => {
  const headers = securityHeaders(API, false);
  const value = (key: string) => headers.find((h) => h.key === key)?.value;
  test("the four fixed headers", () => {
    assert.equal(value("X-Content-Type-Options"), "nosniff");
    assert.equal(value("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.equal(value("X-Frame-Options"), "DENY");
    assert.equal(value("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
  });
  test("the CSP is enforced, not report-only", () => {
    assert.equal(value("Content-Security-Policy"), contentSecurityPolicy(API, false));
    assert.equal(value("Content-Security-Policy-Report-Only"), undefined);
  });
});
