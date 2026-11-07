// How to run (Windows cmd, from web/), with nothing else heavy running:
//   1. API:  cd ..ackend && set DEMO_PLAYERS=lichess:DrNykterstein&& set AI_ENABLED=false&& npx tsx --env-file=.env src/server.ts
//      (DEMO_PLAYERS keeps the demo player frozen: without it a local API would re-import it on the
//       shared Atlas DB. Process env wins over --env-file, so .env stays as it is.)
//   2. Web:  npm run build && npx next start -p 3000
//   3. node scripts/ui-shots.mjs [output folder]   (default: your Desktop)
//
// Screenshots: the dashboard at 1280 px with a filter just changed, and the game review mid-scrub
// (pointer held on the eval graph). Also prints the dashboard's layout shift (CLS) while it
// loads, and saves lens-focus.png: keyboard focus on a coach "where it happens" row.
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE, launch, PAGES, sleep, waitFor } from "./ui-cdp.mjs";

const OUT = process.argv[2] ?? join(homedir(), "Desktop");

const page = await launch(9336);
const P = Object.fromEntries(PAGES.map((p) => [p.name, p]));
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__cls = 0; window.__shifts = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push([Math.round(performance.now()), +e.value.toFixed(4), e.sources?.map(s => s.node?.nodeName + '.' + (s.node?.className?.toString?.() ?? '').slice(0,40)).join('|')]); } }).observe({ type: 'layout-shift', buffered: true });`,
});

// Dashboard at 1280 with a filter just changed (mid-glide).
await page.viewport(1280, 900);
await page.navigate(BASE + P.dashboard.path);
await waitFor(page, P.dashboard.ready, 60_000);
await sleep(3000);
console.log("dashboard layout shift (CLS):", await page.evaluate("window.__cls.toFixed(4)"), JSON.stringify(await page.evaluate("window.__shifts")));
await page.evaluate(`document.getElementById('patterns-title').scrollIntoView({ block: 'start' }); window.scrollBy(0, -16)`);
await sleep(600);
await page.evaluate(`[...document.querySelectorAll('[role=radiogroup][aria-label=Colour] button')].find(b => b.textContent.trim() === 'White').click()`);
await sleep(260);
await page.screenshot(join(OUT, "anim-1-dashboard.png"));

// Game review mid-scrub: the pointer held down on the eval graph, dragged part way.
await page.navigate(BASE + P.review.path);
await waitFor(page, P.review.ready, 60_000);
await sleep(1800);
const r = JSON.parse(await page.evaluate(`JSON.stringify(document.querySelector('[role=slider]').getBoundingClientRect())`));
const y = r.y + r.height / 2;
const mouse = (type, x, buttons) => page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
await mouse("mousePressed", r.x + r.width * 0.2, 1);
for (let f = 0.22; f <= 0.56; f += 0.02) {
  await mouse("mouseMoved", r.x + r.width * f, 1);
  await sleep(25);
}
await sleep(60); // mid-glide of the cursor and the pieces
await page.screenshot(join(OUT, "anim-2-review.png"));
await mouse("mouseReleased", r.x + r.width * 0.56, 0);

// Coach: keyboard focus on a lens row (an SVG link) — is the ring drawn?
await page.navigate(BASE + P.coach.path);
await waitFor(page, P.coach.ready, 60_000);
await sleep(2500);
await page.evaluate(`document.querySelector('a[role=listitem]').scrollIntoView({ block: 'center' })`);
await sleep(1500);
// Tab from just before the first lens row, so the browser treats it as keyboard focus.
await page.evaluate(`(() => { const a = document.querySelector('a[role=listitem]'); const b = document.createElement('button'); b.id='__pre'; a.closest('figure').before(b); b.focus(); })()`);
await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
await sleep(300);
console.log("focused:", await page.evaluate("document.activeElement.getAttribute('aria-label')"), await page.evaluate("getComputedStyle(document.activeElement).outlineStyle"));
await page.screenshot(join(OUT, "lens-focus.png"));
page.close();
