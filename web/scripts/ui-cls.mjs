// How to run (Windows cmd, from web/): node scripts/ui-cls.mjs [base URL] [dashboard|ask|ask-typed]
//   The base defaults to the local build (see ui-motion.mjs for the API + web terminals); pass
//   https://blunderprint.vercel.app to measure the live site. Nothing else needed.
//
// Layout shift on the demo dashboard, during the perf checklist's test 3: load, hover the
// Blunderprint and the heat board, then wheel-scroll to the bottom of the games list and back.
// A layout-shift observer (installed before the page's own scripts) records every shift with the
// elements that moved, their old and new boxes and when (ms since navigation), so the cause is
// named instead of guessed. Prints the total CLS (hadRecentInput excluded, as the probe counts it).
//
// Scenario "ask" (Stage 6): the coach page's three suggested questions, clicked one after another
// (see the comment in the code). Target: CLS under 0.01.
import { BASE as LOCAL, launch, sleep, waitFor, PAGES } from "./ui-cdp.mjs";

const base = process.argv[2] ?? LOCAL;
const dash = PAGES.find((p) => p.name === "dashboard");
const coach = PAGES.find((p) => p.name === "coach-ask");

const OBSERVER = `
  window.__shifts = [];
  const describe = (n) => {
    if (!n || n.nodeType !== 1) return String(n && n.nodeName);
    const cls = (n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || '').toString().trim().split(' ').slice(0, 4).join('.');
    const label = n.getAttribute('aria-label') || n.textContent.trim().slice(0, 40);
    return n.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' "' + label + '"';
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__shifts.push({ t: Math.round(e.startTime), value: e.value, input: e.hadRecentInput, scrollY: Math.round(scrollY),
        sources: (e.sources || []).map((s) => ({ node: describe(s.node), from: [s.previousRect.y, s.previousRect.height].map(Math.round), to: [s.currentRect.y, s.currentRect.height].map(Math.round) })) });
    }
  }).observe({ type: 'layout-shift', buffered: true });
`;

const page = await launch(9341);
try {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 593, deviceScaleFactor: 1.5, mobile: false });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER });
  const mouse = (type, x, y, extra = {}) => page.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  const box = (sel) => page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const marks = [];
  const mark = async (what) => marks.push({ what, t: Math.round(await page.evaluate("performance.now()")) });
  const scenario = process.argv[3] ?? "dashboard";
  if (scenario === "ask-typed") {
    // "Ask the coach", typed: three NEW questions (never cached, so each one streams a live run
    // with its trace) typed into the box and sent with Enter, as real key events. Meant for a
    // local API with COACH_MODEL=scripted (free); each leaves an answer with the usual 30-day expiry.
    await page.navigate(base + coach.path);
    await waitFor(page, "!!document.querySelector('#ask-question')", 90_000, "coach page");
    await sleep(1500);
    for (let i = 0; i < 3; i++) {
      await page.evaluate("document.getElementById('ask-question').scrollIntoView({ block: 'center' })");
      await sleep(400);
      const area = await box("#ask-question");
      const before = await page.evaluate("document.querySelectorAll('article[data-answer]').length");
      await mouse("mousePressed", area.x + 20, area.y + 10, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", area.x + 20, area.y + 10, { button: "left", clickCount: 1 });
      await page.send("Input.insertText", { text: `Where do my mistakes cluster? (layout check ${Date.now()}-${i})` });
      await mark(`send question ${i + 1}`);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await waitFor(page, `document.querySelectorAll('article[data-answer]').length > ${before}`, 120_000, `answer ${i + 1}`);
      await mark(`answer ${i + 1} shown`);
      await sleep(3000);
    }
  } else if (scenario === "ask") {
    // "Ask the coach": the three suggested questions, clicked with real mouse events one after
    // another (so a shift within 500 ms of a click counts as after input, as in a browser), each
    // given its answer plus 3 s for the reveals, the lens and the boards to settle.
    await page.navigate(base + coach.path);
    await waitFor(page, "!!document.querySelector('#ask-heading') && document.querySelectorAll('[data-chip]').length === 3", 90_000, "coach page");
    await sleep(1500);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`document.querySelectorAll('[data-chip]')[${i}].scrollIntoView({ block: 'center' })`);
      await sleep(400);
      const chip = await box(`[data-chip]:nth-of-type(${i + 1})`);
      const before = await page.evaluate("document.querySelectorAll('article[data-answer]').length");
      await mark(`click chip ${i + 1}`);
      await mouse("mousePressed", chip.x + chip.w / 2, chip.y + chip.h / 2, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", chip.x + chip.w / 2, chip.y + chip.h / 2, { button: "left", clickCount: 1 });
      await waitFor(page, `document.querySelectorAll('article[data-answer]').length > ${before}`, 120_000, `answer ${i + 1}`);
      await mark(`answer ${i + 1} shown`);
      await sleep(3000);
    }
  } else {
    await page.navigate(base + dash.path);
    await waitFor(page, dash.ready, 90_000, "dashboard");
    await sleep(1500);
    // Like the checklist: "Patterns" at the top, then hover.
    await page.evaluate(`(() => { const h = [...document.querySelectorAll('h2')].find((e) => e.textContent.trim() === 'Patterns'); if (h) scrollTo(0, h.getBoundingClientRect().top + scrollY - 8); })()`);
    await sleep(600);
    await mark("hover the Blunderprint");
    const bp = await box('[aria-label^="Blunderprint:"]');
    if (bp) for (let i = 0; i < 60; i++) { await mouse("mouseMoved", bp.x + ((i * 37) % bp.w), bp.y + Math.min(bp.h - 1, ((i * 13) % 500))); await sleep(60); }
    await mark("hover the heat board");
    const hb = await box('[aria-label="Errors by square"]');
    if (hb) for (let i = 0; i < 30; i++) { await mouse("mouseMoved", hb.x + ((i * 29) % hb.w), hb.y + ((i * 17) % hb.h)); await sleep(60); }
    await mark("wheel down to the bottom");
    for (let i = 0; i < 120; i++) {
      await mouse("mouseWheel", 640, 300, { deltaX: 0, deltaY: 120 });
      await sleep(70);
      if (await page.evaluate("innerHeight + scrollY >= document.documentElement.scrollHeight - 2")) break;
    }
    await sleep(500);
    await mark("wheel back up");
    for (let i = 0; i < 160; i++) {
      await mouse("mouseWheel", 640, 300, { deltaX: 0, deltaY: -120 });
      await sleep(50);
      if (await page.evaluate("scrollY <= 0")) break;
    }
  }
  await sleep(800);
  const shifts = await page.evaluate("window.__shifts");
  const cls = shifts.filter((s) => !s.input).reduce((a, s) => a + s.value, 0);
  console.log(`base ${base}`);
  console.log(`marks: ${marks.map((m) => `${m.t} ms ${m.what}`).join(" · ")}`);
  for (const s of shifts) {
    console.log(`${s.t} ms · ${s.value.toFixed(4)}${s.input ? " (after input, not counted)" : ""} · scrollY ${s.scrollY}`);
    for (const src of s.sources) console.log(`    ${src.node}: y ${src.from[0]}→${src.to[0]}, h ${src.from[1]}→${src.to[1]}`);
  }
  console.log(`CLS (counted) ${cls.toFixed(3)} from ${shifts.length} shifts`);
} finally {
  page.close();
}
