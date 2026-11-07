// How to run (Windows cmd, from web/): node scripts/ui-frames.mjs [page] [base URL] [runs]
//   page: coach (default), dashboard, review or landing; base defaults to the local build (see
//   ui-motion.mjs for the terminals), or pass https://blunderprint.vercel.app for the live site.
//
// Long animation frames (over 50 ms of work, Chrome's "long-animation-frame" entries) while a page
// loads and is then scrolled to the bottom in steps, like the perf checklist's test 5. Prints, per
// run, how many there were, the worst, its blocking time, and when it happened (ms since
// navigation), so a change can be compared with the live site on the same machine.
import { BASE as LOCAL, launch, PAGES, sleep, waitFor } from "./ui-cdp.mjs";

const [name = "coach", base = LOCAL, runs = "3"] = process.argv.slice(2);
const target = PAGES.find((p) => p.name === name);

const OBSERVER = `
  window.__loaf = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__loaf.push({ t: Math.round(e.startTime), d: Math.round(e.duration), b: Math.round(e.blockingDuration) });
  }).observe({ type: 'long-animation-frame', buffered: true });
`;

const page = await launch(9343);
try {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 593, deviceScaleFactor: 1.5, mobile: false });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER });
  for (let r = 1; r <= Number(runs); r++) {
    await page.navigate(base + target.path);
    await waitFor(page, target.ready, 90_000, name);
    await sleep(2500); // the first screen's animations
    // Down in 300 px steps, pausing like a reader (boards play when they come into view).
    const h = await page.evaluate("document.documentElement.scrollHeight");
    for (let y = 0; y <= h; y += 300) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await sleep(400);
    }
    await sleep(1500);
    const loaf = await page.evaluate("window.__loaf");
    const worst = loaf.reduce((w, e) => (e.d > (w?.d ?? 0) ? e : w), null);
    console.log(
      `run ${r} · ${base}${target.path}: ${loaf.length} long frames` +
        (worst ? ` · worst ${worst.d} ms (blocking ${worst.b} ms) at ${worst.t} ms · all: ${loaf.map((e) => `${e.d}@${e.t}`).join(" ")}` : ""),
    );
  }
} finally {
  page.close();
}
