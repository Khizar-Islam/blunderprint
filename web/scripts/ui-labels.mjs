// How to run (Windows cmd, from web/): start the API and the web build as described at the top
// of ui-audit.mjs, then:
//   node scripts/ui-labels.mjs [output folder]   (default: your Desktop)
//
// The review board's 16 coordinates (8 letters, 8 numbers): each one's computed colour must be
// one of our two notation colours (components/review/Board.tsx: graphite 75% on light squares,
// ink 85% on dark), resolved in the same page so the comparison is exact. Also saves
// board-labels-zoom.png, the bottom rank at 4×, to check the text rendering by eye (Windows
// subpixel smoothing used to fringe these labels blue; Board.tsx explains the fix).
// Then the "Ask the coach" box's labels and announcements (Stage 6, at the end).
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { BASE, launch, PAGES, sleep, waitFor } from "./ui-cdp.mjs";

const OUT = process.argv[2] ?? join(homedir(), "Desktop");
const page = await launch(9337);
const review = PAGES.find((p) => p.name === "review");
await page.viewport(1280, 900);
await page.navigate(BASE + review.path);
await waitFor(page, review.ready, 60_000);
await sleep(1000);

const result = JSON.parse(
  await page.evaluate(`(() => {
  const probe = (color) => { const s = document.createElement('span'); s.style.color = color; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  const ours = {
    light: probe('color-mix(in oklab, var(--color-graphite) 75%, transparent)'),
    dark: probe('color-mix(in oklab, var(--color-ink) 85%, transparent)'),
  };
  const labels = [...document.querySelectorAll('[role=img] [data-square] span')]
    .filter((s) => s.children.length === 0 && /^[a-h1-8]$/.test(s.textContent))
    .map((s) => {
      const sq = s.closest('[data-square]').dataset.square;
      const light = (sq.charCodeAt(0) - 97 + Number(sq[1])) % 2 === 0; // a1 (0 + 1, odd) is dark
      const color = getComputedStyle(s).color;
      return { label: s.textContent, square: sq, on: light ? 'light' : 'dark', color, ok: color === ours[light ? 'light' : 'dark'] };
    });
  const r = document.querySelector('[role=img]').getBoundingClientRect();
  return JSON.stringify({ ours, labels, rank1: { x: r.x, y: r.y + r.height * 7 / 8, width: r.width, height: r.height / 8 } });
})()`),
);

for (const l of result.labels) console.log(`${l.label} (${l.square}, ${l.on.padEnd(5)})  ${l.color}  ${l.ok ? "ok" : "NOT OURS"}`);
const bad = result.labels.filter((l) => !l.ok);
console.log(`\n${result.labels.length} labels, ${bad.length} not in our palette. Ours: light ${result.ours.light} · dark ${result.ours.dark}`);

const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { ...result.rank1, scale: 4 } });
writeFileSync(join(OUT, "board-labels-zoom.png"), Buffer.from(data, "base64"));

// "Ask the coach" (Stage 6): the question box has a visible label and is described by the
// counter and the privacy note; the counter is announced politely and only near the limit (the
// live region is empty while typing a short question); the chips are a labelled group; an
// answered chip says so to screen readers.
const coach = PAGES.find((p) => p.name === "coach-ask");
await page.navigate(BASE + coach.path);
await waitFor(page, "!!document.querySelector('#ask-heading') && document.querySelectorAll('[data-chip]').length === 3", 60_000);
const ask = JSON.parse(
  await page.evaluate(`(() => {
  const box = document.getElementById('ask-question');
  const label = document.querySelector('label[for="ask-question"]');
  const described = (box.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  const live = box.form.querySelector('[aria-live="polite"]');
  const group = document.querySelector('[role=group][aria-labelledby]');
  const chips = [...document.querySelectorAll('[data-chip]')];
  return JSON.stringify({
    label: label ? label.textContent.trim() : null,
    describedBy: described.map((id) => !!document.getElementById(id)),
    liveEmpty: live ? live.textContent.trim() === '' : null,
    groupLabel: group ? document.getElementById(group.getAttribute('aria-labelledby'))?.textContent.trim() : null,
    chips: chips.map((c) => ({ state: c.dataset.chip, sr: c.querySelector('.sr-only')?.textContent ?? null })),
  });
})()`),
);
const askIssues = [];
if (!ask.label) askIssues.push("the question box has no visible label");
if (ask.describedBy.length !== 2 || ask.describedBy.includes(false)) askIssues.push("aria-describedby doesn't point at the counter and the privacy note");
if (ask.liveEmpty !== true) askIssues.push("the counter's live region is missing or not empty for an empty box");
if (!ask.groupLabel) askIssues.push("the chips aren't a labelled group");
for (const c of ask.chips) if (c.state === "answered" && c.sr !== "(answer ready)") askIssues.push("an answered chip doesn't say so to screen readers");
console.log(`\nask: label "${ask.label}", group "${ask.groupLabel}", chips ${ask.chips.map((c) => c.state).join("/")}: ${askIssues.length ? askIssues.join("; ") : "ok"}`);

page.close();
process.exitCode = bad.length || result.labels.length !== 16 || askIssues.length ? 1 : 0;
