// How to run (Windows cmd, from web/): node scripts/ui-games-frame.mjs [base URL] [loads]
//   local: npm run build && npx next start -p 3000 (with the API it points at awake), then the script
//   live:  node scripts/ui-games-frame.mjs https://blunderprint.vercel.app   (read-only: the demo dashboard)
//
// How long is the frame that renders the games list? The demo dashboard on a phone-sized screen
// with the CPU slowed 4× (what Lighthouse's mobile run assumes), every time on the page's own
// clock (ms since navigation). Lists every long animation frame of each load, marks the ones
// that overlap or follow the games response, and prints the median of the longest per load.
// "rendering" is the style/layout/paint part of a frame; the rest is script (React's render).
// Also prints the row heights, which the rows' contain-intrinsic-size must match (GamesList.tsx).
import { BASE as LOCAL, launch, PAGES, sleep, waitFor } from "./ui-cdp.mjs";

const base = process.argv[2] ?? LOCAL;
const loads = Number(process.argv[3] ?? 3);
const dash = PAGES.find((p) => p.name === "dashboard");
const ROWS = `document.querySelectorAll('ol[aria-label="Games, newest first"] > li')`;

const page = await launch(9351);
try {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 823, deviceScaleFactor: 1, mobile: true });
  await page.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__loaf = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), rendering: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0) }); }).observe({ type: 'long-animation-frame', buffered: true });`,
  });
  const longest = [];
  for (let run = 1; run <= loads; run++) {
    await page.navigate(base + dash.path);
    await waitFor(page, dash.ready, 120_000);
    await sleep(5000);
    const data = await page.evaluate(`({
      games: performance.getEntriesByType('resource').filter((r) => /\\/games(\\?|$)/.test(r.name)).map((r) => Math.round(r.responseEnd))[0],
      loaf: window.__loaf,
      rows: ${ROWS}.length,
      heights: [...new Set([...${ROWS}].slice(0, 12).map((li) => Math.round(li.getBoundingClientRect().height * 100) / 100))],
    })`);
    const after = data.loaf.filter((f) => data.games != null && f.start + f.dur > data.games && f.start < data.games + 600);
    const top = after.sort((a, b) => b.dur - a.dur)[0];
    longest.push(top?.dur ?? 0);
    console.log(`load ${run}: ${data.rows} rows (heights ${data.heights.join(", ")} px); games response at ${data.games} ms; ${data.loaf.length} long frames`);
    for (const f of data.loaf) console.log(`   frame at ${String(f.start).padStart(5)} ms: ${String(f.dur).padStart(4)} ms (rendering ${f.rendering})${after.includes(f) ? "  <-- games list" : ""}`);
    console.log(`   longest games-list frame: ${top ? `${top.dur} ms (script ${top.dur - top.rendering}, rendering ${top.rendering})` : "none over 50 ms"}`);
  }
  const sorted = [...longest].sort((a, b) => a - b);
  console.log(`\nlongest games-list frame per load: ${longest.join(", ")} ms · median ${sorted[Math.floor(sorted.length / 2)]} ms (4× CPU, 412×823)`);
} finally {
  page.close();
}
