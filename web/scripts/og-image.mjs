// Makes the link-preview image (what LinkedIn, WhatsApp, Slack… show for a link to the site):
// src/app/opengraph-image.png, 1200×630, committed. Next serves it and adds the og:image tags
// by itself (the "opengraph-image" file convention); the alt text is opengraph-image.alt.txt.
//
// Run by hand (cmd, from web/), with the built site running so the page's own fonts can be used:
//   npm run build && npx next start -p 3000
//   npm run og:image                      (or: npm run og:image -- http://localhost:3000)
// Run it again after every `npm run snapshot:demo`: the image shows the same demo games.
// The player's name is left off the picture on purpose: a shared preview shouldn't read as if
// the player endorsed the project (the landing page names them next to "Not affiliated").
//
// Why a committed picture and not Next's ImageResponse: that renderer only knows flexbox, and
// the print is ~16,000 ticks. Here the REAL painter draws it: geometry.ts's drawRows runs in
// Node against a recording canvas context (run with tsx, so the .ts file can be imported), and
// the recorded rectangles are replayed on a real canvas in headless Chrome.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drawRows, layout } from "../src/components/patterns/geometry.ts";
import { BASE, launch, sleep, waitFor } from "./ui-cdp.mjs";

const base = process.argv[2] ?? BASE;
const OUT = fileURLToPath(new URL("../src/app/opengraph-image.png", import.meta.url));
const demo = JSON.parse(await readFile(new URL("../src/data/demo.json", import.meta.url), "utf8"));

// The print: every game of the snapshot, 2 px rows + 1 px gap (200 games = 600 px of the 630).
const W = 1200;
const H = 630;
const PRINT_W = 640;
const rows = demo.ribbons.map((r) => ({ classes: r.classes, color: r.color }));
const l = layout(PRINT_W, rows.map((r) => r.classes.length), true);
if (l.height > H - 20) throw new Error(`the print is ${l.height} px tall: too many games for a ${H} px image`);
const rects = [];
const recorder = {
  fillStyle: "",
  globalAlpha: 1,
  clearRect() {},
  fillRect(x, y, w, h) {
    rects.push([this.fillStyle, +x.toFixed(2), y, +w.toFixed(2), h]);
  },
};
drawRows(recorder, l, rows, () => 1);

const PLATFORM = { lichess: "Lichess", chesscom: "Chess.com" };
const html = `
  <div id="og" style="position:fixed;inset:0;width:${W}px;height:${H}px;background:#e9e4d8;color:#1b1d1a;overflow:hidden;display:flex">
    <div style="width:${W - PRINT_W - 48}px;padding:56px 0 52px 64px;display:flex;flex-direction:column;justify-content:space-between">
      <div style="font-family:var(--font-newsreader);font-size:30px">Blunderprint</div>
      <div>
        <div style="font-family:var(--font-newsreader);font-size:76px;line-height:1.02;letter-spacing:-0.02em">Your mistakes leave a print.</div>
        <div style="font-family:var(--font-geist-sans);font-size:25px;line-height:1.35;color:#2b2b28;margin-top:26px;max-width:420px">An AI chess coach for your Chess.com and Lichess games.</div>
      </div>
      <div style="font-family:var(--font-geist-mono);font-size:17px;line-height:1.5;color:#2b2b28">${rows.length} real games, one row each<br/>mistakes in colour</div>
    </div>
    <canvas id="print" width="${PRINT_W}" height="${l.height}" style="position:absolute;right:48px;top:${Math.round((H - l.height) / 2)}px"></canvas>
  </div>`;

const page = await launch(9391);
try {
  await page.viewport(W, H);
  await page.navigate(base + "/"); // the landing page loads all three fonts
  await waitFor(page, `!!document.querySelector('canvas')`, 60_000, "the landing page");
  await page.evaluate(`(async () => {
    document.body.innerHTML = ${JSON.stringify(html)};
    const ctx = document.getElementById('print').getContext('2d');
    for (const [colour, x, y, w, h] of ${JSON.stringify(rects)}) { ctx.fillStyle = colour; ctx.fillRect(x, y, w, h); }
    await document.fonts.ready;
  })()`);
  await sleep(500);
  const fonts = await page.evaluate(`['76px Newsreader', '25px Geist', '17px "Geist Mono"'].map((f) => document.fonts.check(f))`);
  if (fonts.includes(false)) throw new Error(`a font isn't loaded (Newsreader, Geist, Geist Mono: ${fonts.join(", ")})`);
  await page.screenshot(OUT);
} finally {
  page.close();
}
console.log(`wrote ${OUT}: ${W}×${H}, ${rows.length} games, ${rects.length} rectangles (${PLATFORM[demo.platform]} · ${demo.username}, snapshot of ${demo.takenAt.slice(0, 10)})`);
