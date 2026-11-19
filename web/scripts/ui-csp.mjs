// How to run (Windows cmd, from web/):
//   node scripts/ui-csp.mjs [base URL] [--engine <platform>/<username>] [--selftest]
//   local: npm run build && npx next start -p 3000 (with the API it points at awake)
//   live:  node scripts/ui-csp.mjs https://blunderprint.vercel.app --engine lichess/EricRosen
//
// Does the site break its own Content-Security-Policy (src/lib/securityHeaders.ts)? Run it while
// the policy is Report-Only (nothing is blocked, violations are only reported) and again after
// it is enforced. It:
//   1. reads the security headers of a page and of the engine's worker script;
//   2. visits the landing page, dashboard, game review and coach page of the demo player and a
//      404, scrolling each to the bottom;
//   3. on the coach page clicks ONE pre-answered chip (data-chip="answered": served from the
//      cache, no AI call). It never types a question and never clicks an unanswered chip;
//   4. with --engine: opens the review page of the shortest unanalysed game of that player and
//      waits until the browser engine's result is stored. Use a STORED, NON-demo player (a demo
//      player's games are never analysed). This is the one step that writes: one analysis
//      result, as any visitor's browser would send. It opens no dashboard, so no import starts.
// Violations are collected two ways: the page's `securitypolicyviolation` events, and the
// console's CSP messages of the page AND of its workers (a worker has its own policy, the one
// that arrived with its script, and reports to its own console).
// Exit code 1 if anything was reported.
//
// --selftest proves the script can see violations at all, and must report one from the page and
// (with --engine) one from the engine's worker:
//   - the page: it makes the landing page try to connect to 127.0.0.1:9 (nothing listens there),
//     which the real policy's connect-src doesn't allow;
//   - the worker: it swaps the policy of the worker script for "default-src 'none'" on the way
//     in (nothing changes on the server). Chrome ignores such a swap for a page's own policy,
//     which is why the page half uses a real violation.
// It leaves the engine page before the analysis finishes, so nothing is stored.
import { BASE as LOCAL, launch, PAGES, scrollThrough, sleep, waitFor } from "./ui-cdp.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const base = args.find((a) => /^https?:/.test(a)) ?? LOCAL;
const selftest = flag("--selftest");
const engine = option("--engine");
const HEADERS = ["x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy", "content-security-policy-report-only", "content-security-policy"];
const WORKER = "/engine/stockfish-19-lite-single.js";

// 1. The headers, as sent.
let policy = "";
for (const path of ["/", WORKER]) {
  const res = await fetch(base + path);
  console.log(`\n${path} → ${res.status}`);
  for (const h of HEADERS) if (res.headers.get(h)) console.log(`  ${h}: ${res.headers.get(h)}`);
  policy ||= res.headers.get("content-security-policy") ?? res.headers.get("content-security-policy-report-only") ?? "";
}
if (!policy) {
  console.error("\nstopped: no Content-Security-Policy header on the site");
  process.exit(1);
}
const api = policy.match(/connect-src ([^;]*)/)?.[1].split(" ").find((s) => /^https?:/.test(s));

const page = await launch(9371);
const found = []; // { where, kind: "event" | "console", text }
let where = "start";
const isCsp = (text) => /Content Security Policy|Content-Security-Policy/i.test(text);

await page.send("Log.enable");
page.on("Log.entryAdded", ({ entry }, sessionId) => {
  // A worker's message also arrives on the page's own console: keep one copy per source.
  const item = { where, kind: sessionId ? "worker console" : "console", text: entry.text.slice(0, 300) };
  if (isCsp(entry.text) && !found.some((f) => f.where === item.where && f.kind === item.kind && f.text === item.text)) found.push(item);
});
page.on("Runtime.consoleAPICalled", () => {});
// Workers: attach to each one before it runs, listen to its console, then let it go.
page.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
  page.send("Log.enable", {}, sessionId).catch(() => {});
  page.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
  if (targetInfo.type === "worker") workers.push(targetInfo.url);
});
const workers = [];
await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective + ' blocked ' + (e.blockedURI || '(inline)') + (e.sourceFile ? ' in ' + e.sourceFile + ':' + e.lineNumber : '') + ' [' + e.disposition + ']'));`,
});

if (selftest) {
  await page.send("Fetch.enable", { patterns: [{ urlPattern: base + "/engine/*", requestStage: "Response" }] });
  page.on("Fetch.requestPaused", (p) => {
    const headers = (p.responseHeaders ?? []).filter((h) => !/^content-security-policy/i.test(h.name));
    headers.push({ name: "Content-Security-Policy-Report-Only", value: "default-src 'none'" });
    page.send("Fetch.continueResponse", { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: headers }).catch(() => page.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {}));
  });
}

// Collects the page's own violation events before it is left.
const collect = async () => {
  for (const text of await page.evaluate("window.__csp || []").catch(() => [])) found.push({ where, kind: "event", text });
};
const visit = async (name, url, ready, after) => {
  where = name;
  const before = found.length;
  await page.navigate(url);
  if (ready) await waitFor(page, ready, 120_000, `${name} to load`);
  await scrollThrough(page);
  if (after) await after();
  await sleep(1000);
  await collect();
  console.log(`${name.padEnd(12)} ${found.length - before === 0 ? "ok, no violations" : `${found.length - before} VIOLATION REPORTS`}`);
};

console.log(`\n${selftest ? "SELF-TEST (violations are expected below)" : "Checking"} ${base}\n`);
await page.viewport(1280, 900);
try {
  const breakIt = () => page.evaluate(`fetch('http://127.0.0.1:9/csp-selftest').catch(() => {})`);
  for (const p of PAGES.filter((q) => q.name !== "coach-ask" && (!selftest || q.name === "landing"))) await visit(p.name, base + p.path, p.ready, selftest ? breakIt : undefined);

  if (!selftest) {
    // One pre-answered chip: its answer comes from the cache with no AI call.
    const coach = PAGES.find((p) => p.name === "coach");
    await visit("coach chip", base + coach.path, `document.querySelectorAll('[data-chip]').length > 0`, async () => {
      const clicked = await page.evaluate(`(() => { const c = document.querySelector('[data-chip="answered"]:not([disabled])'); if (!c) return null; c.click(); return c.innerText.trim(); })()`);
      if (!clicked) return console.log("             (skipped the chip: none is pre-answered, and a click would spend AI calls)");
      await waitFor(page, `!!document.querySelector('article[data-answer]')`, 60_000, "the cached answer");
      console.log(`             clicked "${clicked.slice(0, 60)}"`);
    });
    await visit("404", base + "/no-such-page", `document.readyState === 'complete'`);
  }

  if (engine) {
    const [platform, username] = engine.split("/");
    const get = async (path) => (await fetch(api + path)).json();
    const player = await get(`/api/players/${platform}/${username}`);
    if (!player.player) throw new Error(`${engine} is not a stored player (this script never imports one)`);
    if (player.player.demo) throw new Error(`${engine} is a demo player: its games are never analysed`);
    const list = await get(`/api/players/${platform}/${username}/games?limit=200`);
    const game = list.games.filter((g) => g.analysis?.status === "pending").sort((a, b) => a.plies - b.plies)[0];
    if (!game) throw new Error(`${engine} has no unanalysed game left`);
    await visit("engine", `${base}/p/${platform}/${username}/game/${game.id}`, null, async () => {
      const start = Date.now();
      let status = "pending";
      while (Date.now() - start < (selftest ? 15_000 : 240_000)) {
        await sleep(2000);
        if (selftest ? workers.length > 0 && found.some((f) => f.kind === "worker console") : (status = (await get(`/api/games/${game.id}`)).game?.analysis?.status ?? status) === "done") break;
      }
      console.log(selftest ? `             ${workers.length} worker(s) started; left before the analysis finished` : `             ${engine} game ${game.id} (${game.plies} plies): ${status} after ${Math.round((Date.now() - start) / 1000)} s, ${workers.length} worker(s)`);
      if (!selftest && status !== "done") found.push({ where, kind: "engine", text: `the game was not analysed (status ${status})` });
    });
  }
} finally {
  page.close();
}

console.log("");
for (const f of found) console.log(`  [${f.where}] ${f.kind}: ${f.text}`);
if (selftest) {
  const pageSeen = found.some((f) => f.kind === "event");
  const workerSeen = found.some((f) => f.kind === "worker console");
  console.log(`\nself-test: page violations seen: ${pageSeen}; worker violations seen: ${engine ? workerSeen : "not tested (no --engine)"}`);
  process.exit(pageSeen && (!engine || workerSeen) ? 0 : 1);
}
console.log(found.length ? `\n${found.length} violation report(s)` : "No violations.");
process.exit(found.length ? 1 : 0);
