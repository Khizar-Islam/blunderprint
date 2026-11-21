// The README's demo (docs/img/demo.gif), recorded with headless Chrome's screencast: the landing's
// first screen, the dive, the print carried onto the dashboard, two squares of the heat board, one
// pattern of the coach report and one pre-answered question. A cursor is drawn by the script.
// Safe on live: the only coach interaction is a click on a chip the API says is already answered
// (anything else stops the script); it never types a question.
//
// How to run (from web/; ffmpeg is not in the repo: winget install Gyan.FFmpeg):
//   node scripts/record-demo.mjs https://blunderprint.vercel.app <a new frames folder>
// It writes f-00001.jpg … and frames.txt (an ffmpeg list with each frame's duration). Then, in
// that folder (0.96: a 41.5 s take played in 40 s):
//   ffmpeg -f concat -safe 0 -i frames.txt -vf "setpts=0.96*PTS,fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 16 demo.mp4
//   ffmpeg -f concat -safe 0 -i frames.txt -vf "setpts=0.96*PTS,fps=10,scale=960:-1:flags=lanczos,palettegen=max_colors=100:stats_mode=full:reserve_transparent=0" pal.png
//   ffmpeg -f concat -safe 0 -i frames.txt -i pal.png -filter_complex "[0:v]setpts=0.96*PTS,fps=10,scale=960:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=none:diff_mode=rectangle" demo.gif
// One shared palette of 100 colours keeps the GIF under 10 MB (GitHub shows it inline), but it
// drops the teal of the better-move arrows (they are a tiny part of the picture). The committed
// GIF's palette had eight teal shades painted into its unused entries between the last two steps
// (drawbox on pal.png, x 8–15 of row 15: 3E7C74 28675F 6A968F 9DBAB3 C3D0C8 5F8274 4C7F76 33726A).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep, waitFor } from "./ui-cdp.mjs";

const [B, OUT] = process.argv.slice(2);
if (!/^https?:\/\//.test(B ?? "") || !OUT) {
  console.error("usage: node scripts/record-demo.mjs <site URL> <frames folder>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const W = 1280;
const H = 800;
const page = await launch(9361);
await page.viewport(W, H);

const frames = [];
let recording = false;
page.on("Page.screencastFrame", (f) => {
  page.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  if (!recording) return;
  const name = `f-${String(frames.length + 1).padStart(5, "0")}.jpg`;
  writeFileSync(join(OUT, name), Buffer.from(f.data, "base64"));
  frames.push({ name, t: f.metadata.timestamp });
});
page.on("Runtime.exceptionThrown", (m) => console.log("exception", m.exceptionDetails?.exception?.description?.slice(0, 300)));

// A drawn cursor that follows the real (CDP) mouse, and a ring on each press. Made on the first
// mouse move, long after hydration; it lives on <body>, which in-app navigations keep.
await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  let cur = null;
  const make = () => {
    cur = document.createElement('div');
    cur.setAttribute('aria-hidden', 'true');
    cur.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:24px;height:24px;will-change:transform';
    cur.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2l0 17 4.6-4.2 3 7 2.9-1.3-3-6.8 6.2-.3z" fill="#1B1D1A" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
  };
  addEventListener('mousemove', (e) => { if (!cur || !cur.isConnected) make(); cur.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (e.clientX - 16) + 'px;top:' + (e.clientY - 16) + 'px;width:32px;height:32px;border-radius:50%;border:2px solid #1B1D1A;z-index:2147483646;pointer-events:none;opacity:.7;transform:scale(.3);transition:transform 450ms ease-out,opacity 450ms ease-out';
    document.body.appendChild(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.2)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 600);
  }, true);
  // A scroll played inside the page (frame by frame, eased), so it is smooth in the recording.
  window.__scroll = (to, ms, linear) => new Promise((done) => {
    const from = scrollY, t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = linear ? k : (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
      scrollTo(0, from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step); else done(true);
    };
    step();
  });
})()` });

let mx = 330;
let my = 640;
const mouse = (x, y, type = "mouseMoved") => page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
const glide = async (x, y, ms = 700) => {
  const n = Math.max(2, Math.round(ms / 20));
  const x0 = mx;
  const y0 = my;
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await mouse(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await sleep(20);
  }
  mx = x;
  my = y;
};
const click = async () => {
  await mouse(mx, my, "mousePressed");
  await sleep(70);
  await mouse(mx, my, "mouseReleased");
};
const centre = async (expr) => {
  const r = JSON.parse(await page.evaluate(`JSON.stringify((() => { const r = (${expr}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })())`));
  return r;
};
const scroll = (to, ms, linear = false) => page.evaluate(`window.__scroll(${to}, ${ms}, ${linear})`);
const marks = [];
const mark = (name) => marks.push([name, Date.now()]);

// ---- Warm everything first (the API may be asleep; the recording must not show a wake-up) ----
await page.navigate(B + "/p/lichess/DrNykterstein/coach");
await waitFor(page, `document.querySelectorAll('article').length > 0 && !!document.querySelector('[data-chip]')`, 180_000);
await page.navigate(B + "/p/lichess/DrNykterstein");
await waitFor(page, `!!document.querySelector('[aria-label="Errors by square"]')`, 180_000);
await page.navigate(B + "/");
await waitFor(page, "!!document.querySelector('canvas')", 120_000);
await sleep(1500);
await page.navigate("about:blank");

// ---- 1. The landing: the entrance, the print developing, the band and its figure ----
const t0 = Date.now();
recording = true;
await page.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
mark("start");
await page.navigate(B + "/");
mark("landing loaded");
await sleep(4400);

// ---- 2. The dive ----
const [top, len] = JSON.parse(await page.evaluate(`JSON.stringify((() => { const t = document.querySelector('[data-dive] .sticky').parentElement; return [t.getBoundingClientRect().top + scrollY, t.offsetHeight - innerHeight]; })())`));
mark("dive");
await scroll(top + len, 8200, true);
await sleep(1500);

// ---- 3. The print is carried onto the dashboard (the carry starts from the whole print, so: back to the top) ----
mark("back up");
await scroll(0, 900);
await waitFor(page, `!!document.querySelector('canvas[data-print]')`, 5000);
await mouse(mx, my);
const row1 = await centre(`document.querySelector('[data-dive-hero] a[href*="/p/lichess/DrNykterstein"]')`);
await glide(row1[0] - 60, row1[1], 600);
await sleep(350);
mark("click row 1");
await click();
await waitFor(page, `location.pathname === '/p/lichess/DrNykterstein' && !!document.querySelector('[data-print-line]') && !!document.querySelector('[aria-label="Errors by square"]')`, 30_000);
mark("dashboard");
await sleep(1900);
const printY = await page.evaluate(`Math.round(document.querySelector('[aria-label^="Blunderprint:"]').getBoundingClientRect().top + scrollY)`);
await scroll(printY - 90, 1100);
await sleep(500);
const sq = (prefix) => centre(`[...document.querySelectorAll('[aria-label="Errors by square"] button')].find((b) => b.getAttribute('aria-label').startsWith('${prefix} '))`);
const e5 = await sq("e5");
mark("hover e5");
await glide(e5[0], e5[1], 800);
await sleep(2000);
const d4 = await sq("d4");
await glide(d4[0], d4[1], 450);
await sleep(1500);

// ---- 4. The coach report: one pattern, its boards, a pre-answered chip ----
mark("to coach");
await scroll(0, 800);
const cta = await centre(`[...document.querySelectorAll('a')].find((a) => /coach report/.test(a.textContent))`);
await glide(cta[0], cta[1], 700);
await sleep(300);
await click();
await waitFor(page, `location.pathname.endsWith('/coach') && document.querySelectorAll('article').length > 0`, 30_000);
mark("coach page");
await sleep(1500);
const cardY = await page.evaluate(`Math.round(document.querySelector('article').getBoundingClientRect().top + scrollY)`);
await scroll(cardY - 24, 800);
await sleep(1200);
await scroll(cardY + 520, 1300);
await sleep(3200);
const chipSel = `[...document.querySelectorAll('[data-chip]')].find((c) => c.textContent.startsWith('Why do I lose so many games in time trouble?'))`;
// Only a chip the API says is already answered is ever clicked: anything else would be a real AI call.
const state = await page.evaluate(`(${chipSel})?.dataset.chip`);
if (state !== "answered") throw new Error(`the chip is "${state}", not answered: not clicking`);
const chipY = await page.evaluate(`Math.round((${chipSel}).getBoundingClientRect().top + scrollY)`);
mark("to ask");
await scroll(chipY - 300, 1200);
const chip = await centre(chipSel);
await glide(chip[0], chip[1], 600);
await sleep(300);
mark("click chip");
await click();
await waitFor(page, `!!document.querySelector('article[data-answer]')`, 20_000);
mark("answer");
await sleep(3600);
recording = false;
await page.send("Page.stopScreencast");
mark("end");

let list = "ffconcat version 1.0\n";
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 0.5;
  list += `file ${frames[i].name}\nduration ${Math.max(0.001, d).toFixed(4)}\n`;
}
list += `file ${frames.at(-1).name}\n`;
writeFileSync(join(OUT, "frames.txt"), list);
const span = frames.at(-1).t - frames[0].t;
console.log(`frames ${frames.length}, ${span.toFixed(1)} s, ${(frames.length / span).toFixed(1)} fps on average`);
console.log(marks.map(([n, t]) => `${((t - t0) / 1000).toFixed(1)} ${n}`).join("\n"));
page.close();
