// The README's screenshots (docs/img/), taken from the frozen demo player's pages over headless Chrome.
//
// How to run (Windows cmd, from web/), with nothing else heavy running:
//   node scripts/ui-readme-shots.mjs https://blunderprint.vercel.app [output folder]
//   (default output: ..\docs\img; a local site works too: http://localhost:3000)
//
// Safe against the live site: it only reads pages, and on "Ask the coach" it clicks one suggested
// question, and only a chip that already has a cached answer (data-chip="answered"), so it never
// spends an AI call. It never types a question. If no chip is answered, it stops with an error.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, PAGES, scrollThrough, sleep, waitFor } from "./ui-cdp.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/ui-readme-shots.mjs <site URL> [output folder]");
  process.exit(1);
}
const OUT = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "img"));
mkdirSync(OUT, { recursive: true });

const SCALE = 1.5; // sharper than 1 on a README, about half the bytes of 2
const P = Object.fromEntries(PAGES.map((p) => [p.name, p]));
const page = await launch(9337);
const viewport = (width, height) => page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: SCALE, mobile: false });

// Saves the viewport, or with `selector` just that element (plus a margin), as a PNG.
async function shot(name, selector, margin = 16) {
  const params = { format: "png" };
  if (selector) {
    const r = JSON.parse(
      await page.evaluate(`(() => { const r = (${selector}).getBoundingClientRect(); return JSON.stringify({ x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }); })()`),
    );
    params.clip = { x: Math.max(0, r.x - margin), y: Math.max(0, r.y - margin), width: r.w + margin * 2, height: r.h + margin * 2, scale: 1 };
    params.captureBeyondViewport = true;
  }
  const { data } = await page.send("Page.captureScreenshot", params);
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log("saved", file);
}

// 1. Landing: the first screen once the print has developed (~4 s) and the note on one move is placed.
await viewport(1280, 840);
await page.navigate(base + P.landing.path);
await waitFor(page, P.landing.ready, 90_000);
await sleep(8000);
await shot("landing.png");

// 2. Dashboard: the Blunderprint and the heat board, then the charts below them.
await viewport(1280, 900);
await page.navigate(base + P.dashboard.path);
await waitFor(page, P.dashboard.ready, 120_000); // may have to wake the API first
await sleep(3000);
await scrollThrough(page);
await page.evaluate(`document.getElementById('patterns-title').scrollIntoView({ block: 'start' }); window.scrollBy(0, -16)`);
await sleep(1500);
await shot("dashboard.png");
await page.evaluate(`window.scrollBy(0, 860)`);
await sleep(1500);
await shot("dashboard-charts.png");

// 3. Game review at the demo move (a judged move, so the "Better was…" line is showing).
await viewport(1280, 800);
await page.navigate(base + P.review.path);
await waitFor(page, P.review.ready, 90_000);
await sleep(3000);
await shot("review.png");

// 4. Coach report: the first pattern card with its lens, numbers and evidence boards. A tall
//    viewport, so every board is near the screen and mounts; then time for the boards to play.
await viewport(1280, 2400);
await page.navigate(base + P.coach.path);
await waitFor(page, P.coach.ready, 90_000);
await sleep(2000);
await scrollThrough(page, 400, 250);
await sleep(7000);
await shot("coach-pattern.png", `document.querySelector('article')`);

// 5. "How this report was made": the finished run's trace, opened (one GET, no AI call).
const opened = await page.evaluate(
  `(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('How this report was made')); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`,
);
if (opened) {
  await waitFor(page, `!!document.querySelector('section[aria-label="The coach\\'s working"]')`, 30_000, "the report's trace");
  await sleep(1500);
  await shot("coach-trace.png", `document.querySelector('section[aria-label="The coach\\'s working"]')`, 2); // a small margin: 16 px would cut through the line above
} else console.log("skipped coach-trace.png: no 'How this report was made' control on the page");

// 6. Ask the coach: the question box and its chips, then one pre-answered chip (cached, so no AI
//    call) and its answer card.
await waitFor(page, `document.querySelectorAll('[data-chip]').length > 0`, 30_000, "the suggested questions");
await page.evaluate(`document.getElementById('ask-heading').scrollIntoView({ block: 'center' })`);
await sleep(1500);
await shot("ask-box.png", `document.getElementById('ask-heading').closest('section') ?? document.getElementById('ask-heading').parentElement`);
const clicked = await page.evaluate(
  `(() => { const c = document.querySelector('[data-chip="answered"]:not([disabled])'); if (!c) return null; c.scrollIntoView({ block: 'center' }); c.click(); return c.textContent.trim(); })()`,
);
if (!clicked) {
  page.close();
  console.error("stopped: no pre-answered chip on the page (a click would spend AI calls). Run npm run demo:answers first.");
  process.exit(1);
}
console.log("clicked the answered chip:", clicked);
await waitFor(page, `!!document.querySelector('article[data-answer]')`, 30_000, "the answer");
await page.evaluate(`document.querySelector('article[data-answer]').scrollIntoView({ block: 'start' })`);
await sleep(7000);
await shot("ask-answer.png", `document.querySelector('article[data-answer]')`);

page.close();
