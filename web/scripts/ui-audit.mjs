// How to run (Windows cmd, from web/), with nothing else heavy running:
//   1. API:  cd ..ackend && set DEMO_PLAYERS=lichess:DrNykterstein&& set AI_ENABLED=false&& npx tsx --env-file=.env src/server.ts
//      (DEMO_PLAYERS keeps the demo player frozen: without it a local API would re-import it on the
//       shared Atlas DB. Process env wins over --env-file, so .env stays as it is.)
//   2. Web:  npm run build && npx next start -p 3000
//   3. node scripts/ui-audit.mjs            (or name pages: node scripts/ui-audit.mjs coach review)
//
// Check 1: every button, link, [role=button] and [tabindex] on every page changes style on :hover
// and on :active, and has a visible focus ring (:focus-visible). Forced with CSS.forcePseudoState.
// Transitions and animations are switched off during the audit, so a computed style reads the
// final value at once. A "change" is any difference in a set of visual properties of the element
// or one of its descendants (e.g. a row's band inside an SVG link).
import { BASE, launch, PAGES, scrollThrough, sleep, waitFor } from "./ui-cdp.mjs";

const PROPS = [
  "color", "background-color", "background-image", "border-top-color", "border-bottom-color", "border-left-color",
  "outline-style", "outline-color", "outline-width", "outline-offset", "text-decoration-line", "text-decoration-color",
  "opacity", "transform", "scale", "translate", "box-shadow", "fill", "stroke", "stroke-width", "filter",
];

const SETUP = `(() => {
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(s);
  const els = [...document.querySelectorAll('button, a[href], [role=button], [tabindex]')]
    .filter((e) => e.getAttribute('tabindex') !== '-1' && !e.disabled && e.getClientRects().length > 0 && !e.closest('[inert]'));
  els.forEach((e, i) => e.setAttribute('data-audit', i));
  const props = ${JSON.stringify(PROPS)};
  window.__snap = (i) => {
    const el = document.querySelector('[data-audit="' + i + '"]');
    const nodes = [el, ...el.querySelectorAll('*')].slice(0, 40);
    return JSON.stringify(nodes.map((n) => { const cs = getComputedStyle(n); return props.map((p) => cs.getPropertyValue(p)); }));
  };
  // A ring on the element itself (outline or box-shadow), or, for SVG links, an ink stroke that a
  // child draws only under focus (compared with the unfocused snapshot).
  window.__ring = (i) => {
    const el = document.querySelector('[data-audit="' + i + '"]');
    const cs = getComputedStyle(el);
    if ((cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none') return true;
    return [...el.querySelectorAll('*')].some((n) => { const s = getComputedStyle(n).stroke; return s !== 'none' && s !== 'rgba(0, 0, 0, 0)' && n.dataset.stroked !== s; });
  };
  window.__markStrokes = (i) => {
    document.querySelectorAll('[data-audit="' + i + '"] *').forEach((n) => { n.dataset.stroked = getComputedStyle(n).stroke; });
  };
  window.__desc = (i) => {
    const e = document.querySelector('[data-audit="' + i + '"]');
    if (!e) return null;
    return e.tagName.toLowerCase() + (e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : '') + ' "' + (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 50) + '"';
  };
  return els.length;
})()`;

const page = await launch(9333);
await page.send("DOM.enable");
await page.send("CSS.enable");
const results = [];

for (const p of PAGES.filter((q) => process.argv.length < 3 || process.argv.slice(2).includes(q.name))) {
  await page.viewport(1280, 900);
  await page.navigate(BASE + p.path);
  await waitFor(page, p.ready, 60_000, `${p.name} ready`);
  await sleep(p.name === "landing" ? 6500 : 2500); // the hero finishes; data settles
  await scrollThrough(page);
  await sleep(1500);
  const count = await page.evaluate(SETUP);
  const { root } = await page.send("DOM.getDocument", { depth: 0 });
  const fails = { hover: [], active: [], focus: [] };
  const kinds = {};
  for (let i = 0; i < count; i++) {
    const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-audit="${i}"]` });
    const desc = await page.evaluate(`__desc(${i})`);
    if (!nodeId || !desc) {
      fails.gone = [...(fails.gone ?? []), i];
      continue;
    }
    const kind = desc.split(" ")[0];
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    const base = await page.evaluate(`__snap(${i})`);
    for (const state of ["hover", "active"]) {
      await page.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [state] });
      const after = await page.evaluate(`__snap(${i})`);
      if (after === base) fails[state].push(desc);
      await page.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    }
    await page.evaluate(`__markStrokes(${i})`);
    await page.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
    if (!(await page.evaluate(`__ring(${i})`))) fails.focus.push(desc);
    await page.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  }
  results.push({ page: p.name, count, kinds, fails });
  console.log(JSON.stringify({ page: p.name, count, kinds, hoverFail: fails.hover.length, activeFail: fails.active.length, focusFail: fails.focus.length }));
  for (const [k, list] of Object.entries(fails)) {
    const uniq = [...new Set(list)];
    if (uniq.length) console.log(`  ${k} failures (${list.length}):`, uniq.slice(0, 15));
  }
}
page.close();
