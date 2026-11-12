// How to run (Windows cmd, from web/), with nothing else heavy running:
//   1. API:  cd ..ackend && set DEMO_PLAYERS=lichess:DrNykterstein&& set AI_ENABLED=false&& npx tsx --env-file=.env src/server.ts
//      (DEMO_PLAYERS keeps the demo player frozen: without it a local API would re-import it on the
//       shared Atlas DB. Process env wins over --env-file, so .env stays as it is.)
//   2. Web:  npm run build && npx next start -p 3000
//   3. node scripts/ui-motion.mjs           (or name pages, as for ui-audit)
//
// Checks 2–4.
//  2. Reduced motion emulated: right after each page's content appears, nothing is animating and
//     everything is already final.
//  3. requestAnimationFrame disabled before load: every number, bar and the hero reach their final
//     values within 2 s of the content appearing.
//  4. 390 px wide: no horizontal overflow.
// "Final" is checked the same way in 2 and 3:
//  - no running CSS animation/transition (document.getAnimations());
//  - every AnimatedNumber shows the same text as its screen-reader copy;
//  - every .bar-x has no animation left, so its transform is the one in its style;
//  - nothing still waiting to be revealed in the viewport (.reveal-wait);
//  - every "Ask the coach" figure in view has its rule fully drawn (page coach-ask);
//  - landing: the hero counter reads 200, all notes shown, Replay enabled (= finished);
//  - every canvas is unchanged over 300 ms (not mid-drawing).
import { BASE, launch, PAGES, scrollThrough, sleep, waitFor } from "./ui-cdp.mjs";

const FINAL = `((core) => {
  const issues = [];
  const running = document.getAnimations().filter((a) => a.playState === 'running' && (!core || a.effect?.target?.classList?.contains('bar-x')));
  if (running.length) issues.push(running.length + ' running animations: ' + [...new Set(running.map((a) => (a.animationName || a.transitionProperty || a.constructor.name) + ' on ' + (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '').toString().slice(0, 40)))].slice(0, 4).join(' | '));
  document.querySelectorAll('span[aria-hidden="true"] + span.sr-only').forEach((sr) => {
    const r = sr.parentElement.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return; // below the fold: held until scrolled to
    const shown = sr.previousElementSibling.textContent.trim();
    if (shown !== sr.textContent.trim()) issues.push('number "' + shown + '" ≠ "' + sr.textContent.trim() + '"');
  });
  const vh = innerHeight;
  document.querySelectorAll('.reveal-wait').forEach((e) => { const r = e.getBoundingClientRect(); if (r.top < vh && r.bottom > 0) issues.push('unrevealed in view: ' + e.tagName); });
  // "Ask the coach" figures: the teal rule under each number fully drawn (globals.css figure-in).
  document.querySelectorAll('.figure-rule').forEach((e) => { const r = e.getBoundingClientRect(); if (r.top < vh && r.bottom > 0 && getComputedStyle(e).backgroundSize !== '100% 2px') issues.push('figure rule not drawn: ' + e.textContent.trim().slice(0, 30)); });
  const counter = document.querySelector('figure p.font-mono span[aria-hidden="true"]');
  if (location.pathname === '/') {
    if (counter?.textContent.trim() !== '200') issues.push('hero counter ' + counter?.textContent);
    const replay = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Replay');
    if (replay && replay.disabled) issues.push('hero not finished (Replay disabled)');
    const notes = [...document.querySelectorAll('.hero-in')].filter((e) => getComputedStyle(e).opacity !== '1' && e.tagName !== 'path' && e.tagName !== 'text');
    if (notes.length) issues.push(notes.length + ' hero notes/rings not shown');
  }
  return issues;
})(window.__core)`;

const CANVAS = `[...document.querySelectorAll('canvas')].map((c) => { try { return c.toDataURL().length + ':' + c.toDataURL().slice(-40); } catch { return 'x'; } }).join(',')`;

async function finalState(page, core = false) {
  await page.evaluate(`window.__core = ${core}`);
  const a = await page.evaluate(CANVAS);
  await sleep(300);
  const b = await page.evaluate(CANVAS);
  const issues = await page.evaluate(FINAL);
  if (a !== b) issues.push("a canvas is still changing");
  return issues;
}

const page = await launch(9335);
const only = process.argv.slice(2);
if (only.length) PAGES.splice(0, PAGES.length, ...PAGES.filter((p) => only.includes(p.name)));
const out = [];

// ---- 2. Reduced motion ----------------------------------------------------------------------
await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
for (const p of PAGES) {
  await page.viewport(1280, 900);
  await page.navigate(BASE + p.path);
  await waitFor(page, p.ready, 60_000);
  await sleep(150); // one render pass after the data arrived; no animation time
  const atOnce = await finalState(page);
  await scrollThrough(page, 600, 60);
  const afterScroll = await finalState(page);
  out.push(["reduced", p.name, atOnce.length || afterScroll.length ? "FAIL" : "ok", [...atOnce, ...afterScroll]]);
}
await page.send("Emulation.setEmulatedMedia", { features: [] });

// ---- 3. requestAnimationFrame disabled before load -------------------------------------------
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source: "window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};",
});
for (const p of PAGES) {
  await page.viewport(1280, 900);
  await page.navigate(BASE + p.path);
  await waitFor(page, p.ready, 60_000);
  const t0 = Date.now();
  let issues = [];
  let took = null;
  while (Date.now() - t0 < 4000) {
    issues = await finalState(page, true);
    if (issues.length === 0) {
      took = Date.now() - t0;
      break;
    }
  }
  // Everything else (the coach's evidence-board choreography): it must finish, however long it is.
  let all = null;
  while (Date.now() - t0 < 8000) {
    if ((await finalState(page)).length === 0) {
      all = Date.now() - t0;
      break;
    }
  }
  // Below the fold too: scroll there and allow each reveal its own 2 s.
  await scrollThrough(page, 600, 60);
  const lower = [];
  const h = await page.evaluate("document.documentElement.scrollHeight");
  for (let y = 0; y < h; y += 800) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(2000);
    await page.evaluate("window.__core = true");
    const iss = await page.evaluate(FINAL);
    if (iss.length) lower.push(`@${y}px: ${iss.join("; ")}`);
  }
  out.push(["no-rAF", p.name, took !== null && took <= 2000 && lower.length === 0 ? "ok" : "FAIL", took === null ? issues : [`numbers/bars/hero final after ${took} ms (incl. a 300 ms canvas sample)`, `everything still after ${all ?? ">8000"} ms`, ...lower]]);
}

// ---- 4. 390 px ----------------------------------------------------------------------------------
for (const p of PAGES) {
  await page.viewport(390, 844, true);
  await page.navigate(BASE + p.path);
  await waitFor(page, p.ready, 60_000);
  await sleep(2500);
  await scrollThrough(page, 600, 60);
  const w = await page.evaluate("JSON.stringify([document.documentElement.scrollWidth, document.documentElement.clientWidth, [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.closest('[class*=overflow-x-auto]') && !e.closest('.overflow-hidden') && !e.closest('.sr-only')).slice(0,5).map(e => e.tagName + '.' + (e.className?.baseVal ?? e.className).toString().slice(0,50))])");
  const [sw, cw, offenders] = JSON.parse(w);
  out.push(["390px", p.name, sw <= cw ? "ok" : "FAIL", [`scrollWidth ${sw} / viewport ${cw}`, ...offenders]]);
}

page.close();
for (const [check, name, verdict, notes] of out) console.log(`${check.padEnd(8)} ${name.padEnd(10)} ${verdict}  ${notes.join(" · ")}`);
