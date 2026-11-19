// How to run (Windows cmd, from web/):
//   node scripts/ui-contrast.mjs [base URL] [--shots <folder>] [page names…]
//   local: npm run build && npx next start -p 3000 (with the API it points at awake)
//   live:  node scripts/ui-contrast.mjs https://blunderprint.vercel.app   (read-only: the demo pages;
//          on the coach page it clicks only a pre-answered chip)
//
// Is every piece of text readable? Measures the contrast of all visible text on every page, at
// 1280 and 390 px, against WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text (24 px and up,
// or 18.66 px and up in bold).
// For each text node it takes the REAL colours from the page: the computed text colour (or an
// SVG text's fill), blended with every ancestor's opacity, over whatever is painted under it
// (the background colours and SVG fills under the text's first line, stacked until one is
// solid, so a highlight sliding behind a label counts too). Any CSS colour
// (rgb, oklab, color-mix…) is turned into sRGB by painting it on a 1×1 canvas.
// Also checked: an input's placeholder. Listed but not counted as failures: text in a disabled
// control (AA exempts it), text over a background IMAGE (a gradient or picture can't be
// measured this way: look at it) and a lone ■ (a colour swatch in a legend, not text to read).
// Not seen at all: text drawn on a <canvas> (the Blunderprint's and the hero's own labels are
// HTML, not canvas) and the hover and focus states of controls.
// --shots <folder> also saves a full-page screenshot of every page and width there.
// Exit code 1 if any text is under its threshold.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE as LOCAL, launch, PAGES, scrollThrough, sleep, waitFor } from "./ui-cdp.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a)) ?? LOCAL;
const shots = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const only = args.filter((a, i) => !/^https?:|^--/.test(a) && args[i - 1] !== "--shots");
const pages = PAGES.filter((p) => p.name !== "coach" && (only.length ? only.includes(p.name) : true));
if (shots) mkdirSync(shots, { recursive: true });

const MEASURE = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const rgba = (css) => {
    if (cache.has(css)) return cache.get(css);
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = css; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    const a = d[3] / 255;
    const v = a === 0 ? [0, 0, 0, 0] : [d[0], d[1], d[2], a];
    cache.set(css, v); return v;
  };
  const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3]));
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  // The background behind a piece of text: everything painted under its first line's centre
  // (elementsFromPoint, top first: so a highlight that slides behind a label counts although it
  // isn't the label's ancestor), background colours and SVG fills stacked until one is solid.
  const SHAPES = 'rect, path, circle, ellipse, polygon';
  const backdrop = (el, rect) => {
    const layers = []; let image = false;
    const at = (r) => document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    let stack = at(rect);
    // Scrolled out of sight inside a scrolling box (the filter row on a phone, the move list):
    // bring it into view and look again, so a highlight that is its sibling still counts.
    if (!stack.includes(el)) { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); stack = at(el.getBoundingClientRect()); }
    if (!stack.includes(el)) { stack = []; for (let e = el; e; e = e.parentElement) stack.push(e); }
    for (const e of stack) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') image = true;
      const c = e instanceof SVGElement && e.matches(SHAPES) && e !== el ? rgba(cs.fill).map((v, i) => (i === 3 ? v * parseFloat(cs.fillOpacity) : v)) : rgba(cs.backgroundColor);
      const a = c[3] * opacityOf(e);
      if (a > 0) { layers.push([c[0], c[1], c[2], a]); if (a >= 0.999) break; }
    }
    let bg = [255, 255, 255];
    for (const l of layers.reverse()) bg = over(l, bg);
    return { bg, image };
  };
  const describe = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).filter((c) => /text-|bg-|font-/.test(c)).slice(0, 4).join('.') : '');
  const out = [];
  const add = (el, text, colour, kind, rect) => {
    const cs = getComputedStyle(el);
    const fgRaw = rgba(colour);
    const alpha = fgRaw[3] * opacityOf(el);
    if (alpha < 0.05) return; // not shown (yet): nothing to read
    const { bg, image } = backdrop(el, rect);
    if (/^[■●▪]+$/.test(text.trim())) kind = 'swatch'; // a colour sample, not text to read
    const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], alpha], bg);
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const disabled = !!el.closest('button:disabled, [aria-disabled="true"], input:disabled, textarea:disabled');
    out.push({ kind: kind === 'swatch' ? kind : disabled ? 'disabled' : image ? 'over-image' : kind, fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100, need: large ? 3 : 4.5, size: Math.round(size * 10) / 10, where: describe(el), text: text.trim().replace(/\\s+/g, ' ').slice(0, 40) });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest('script, style, noscript, [data-perf-probe]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const r = range.getClientRects()[0];
    if (!r || r.width < 2 || r.height < 2) continue; // visually hidden (screen-reader only) text
    let hidden = false; // … also when hidden by a 1 px clipping ancestor (Tailwind's sr-only)
    for (let e = el; e && !hidden; e = e.parentElement) { const b = e.getBoundingClientRect(); hidden = b.width <= 1 && b.height <= 1 && getComputedStyle(e).overflow !== 'visible'; }
    if (hidden) continue;
    const svg = el instanceof SVGElement;
    add(el, n.nodeValue, svg ? cs.fill : cs.color, 'text', r);
  }
  for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) if (!el.value) add(el, el.getAttribute('placeholder'), getComputedStyle(el, '::placeholder').color, 'placeholder', el.getBoundingClientRect());
  return out;
})()`;

const page = await launch(9395);
const groups = new Map(); // one line per distinct colour pair + size class + place
let total = 0;
try {
  for (const width of [1280, 390]) {
    await page.viewport(width, 900, width < 640);
    for (const p of pages) {
      await page.navigate(base + p.path);
      await waitFor(page, p.ready, 120_000, `${p.name} to load`);
      await scrollThrough(page);
      await sleep(p.name === "landing" ? 7000 : 2500); // reveals, counters, typed lines and the hero have landed
      // Everything must be inside the viewport for elementsFromPoint, and nothing may be skipped
      // for ignoring the pointer: a tall viewport and pointer-events on, for the measurement only.
      const height = Math.min(await page.evaluate("document.documentElement.scrollHeight"), 30000);
      await page.viewport(width, height, width < 640);
      await page.evaluate(`(() => { const s = document.createElement('style'); s.id = 'contrast-probe'; s.textContent = '* { pointer-events: auto !important; }'; document.head.appendChild(s); })()`);
      await sleep(600);
      const items = await page.evaluate(MEASURE);
      await page.evaluate("document.getElementById('contrast-probe').remove()");
      total += items.length;
      for (const it of items) {
        const key = [it.kind, it.fg, it.bg, it.need, it.where].join("|");
        const g = groups.get(key) ?? { ...it, count: 0, pages: new Set() };
        g.count++;
        g.pages.add(`${p.name}@${width}`);
        groups.set(key, g);
      }
      if (shots) {
        const { cssContentSize: s } = await page.send("Page.getLayoutMetrics");
        const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: s.width, height: Math.min(s.height, 12000), scale: 1 } });
        writeFileSync(join(shots, `${p.name}-${width}.png`), Buffer.from(data, "base64"));
      }
      await page.viewport(width, 900, width < 640);
    }
  }
} finally {
  page.close();
}

const all = [...groups.values()];
const line = (g) => `  ${String(g.ratio.toFixed(2)).padStart(5)} (needs ${g.need})  ${g.fg} on ${g.bg}  ${String(g.size).padStart(4)}px  ×${String(g.count).padEnd(4)} ${g.where}  "${g.text}"  [${[...g.pages].join(", ")}]`;
const failing = all.filter((g) => (g.kind === "text" || g.kind === "placeholder") && g.ratio < g.need).sort((a, b) => a.ratio - b.ratio);
const exempt = all.filter((g) => (g.kind === "disabled" || g.kind === "over-image" || g.kind === "swatch") && g.ratio < g.need).sort((a, b) => a.ratio - b.ratio);
console.log(`\n${base}: ${total} pieces of text on ${pages.length} pages × 2 widths, ${all.length} distinct colour pairs`);
console.log(`\nUNDER AA (${failing.length} pairs, ${failing.reduce((n, g) => n + g.count, 0)} pieces of text):`);
for (const g of failing) console.log(line(g));
console.log(`\nNot counted (${exempt.length} pairs): disabled controls, text over a background image, colour swatches (■)`);
for (const g of exempt) console.log(`  [${g.kind}]` + line(g));
const lowest = all.filter((g) => g.kind === "text" && g.ratio >= g.need).sort((a, b) => a.ratio - b.ratio).slice(0, 8);
console.log(`\nLowest passing pairs:`);
for (const g of lowest) console.log(line(g));
console.log(failing.length ? `\n${failing.length} colour pair(s) under WCAG AA` : "\nAll text meets WCAG AA.");
process.exit(failing.length ? 1 : 0);
