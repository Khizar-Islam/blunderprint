// The print, carried from the landing page onto the demo dashboard.
//
// "Open this Blunderprint" on the landing's first screen leads to the same 200 games drawn
// again by the dashboard. Without this the print vanishes with the old page and a new one
// sweeps in further down. With it, a COPY of the landing's print (one fixed canvas on <body>,
// outside React, so the route change doesn't touch it) stays where it was, and when the
// dashboard has drawn, the copy moves onto its counterpart there and fades away:
// - onto the dashboard's own print, when a good part of it is on screen;
// - otherwise it is pressed flat into the plate's one-line strip ([data-print-line], Plate.tsx),
//   which is exactly that: the same games on the same move axis, pressed into one line. On a
//   laptop screen the print itself starts at the very bottom, so this is the usual landing.
//
// - Only a transform and opacity on a fixed element: nothing is laid out again, so it can't
//   cause layout shift.
// - It always ends: a timer removes the copy if the dashboard's print never arrives (a sleeping
//   server, another page), and another one if the browser runs no animation frames.
// - No reduced motion, no carry; and none when the print isn't (mostly) on screen where it
//   starts. If neither counterpart is on screen where it would land, the copy just fades.

export type Box = { left: number; top: number; width: number; height: number };

export const CARRY_MS = 700; // the move onto its counterpart, fade included
export const CARRY_HOLD = 0.72; // … the copy is fully there for this share of it, then fades
export const CARRY_WAIT_MS = 1500; // how long the copy waits for the dashboard's print
const GIVE_UP_FADE_MS = 200;

export const carryKey = (platform: string, username: string) => `${platform}:${username.toLowerCase()}`;

// The transform that puts a box-sized element (laid at 0,0, origin top left) onto `to`.
export function carryTransform(from: Box, to: Box): string {
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  return `translate(${to.left.toFixed(2)}px, ${to.top.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
}

// The share of a box that is inside the viewport (0 to 1).
export function visibleShare(box: Box, vw: number, vh: number): number {
  if (box.width <= 0 || box.height <= 0) return 0;
  const w = Math.max(0, Math.min(box.left + box.width, vw) - Math.max(box.left, 0));
  const h = Math.max(0, Math.min(box.top + box.height, vh) - Math.max(box.top, 0));
  return (w * h) / (box.width * box.height);
}

// Worth starting: most of the print is on screen. Worth landing: a good part of the
// dashboard's print is (on a phone it sits a screen further down: the copy just fades).
export const canStart = (from: Box, vw: number, vh: number) => visibleShare(from, vw, vh) >= 0.6;
export const canLand = (to: Box, vw: number, vh: number) => to.width > 0 && to.height > 0 && visibleShare(to, vw, vh) >= 0.25;

// The `data-print` attribute the landing's canvas carries while its print is whole:
// "x,y,width,height" in CSS pixels inside the canvas.
export function parsePrintBox(text: string | undefined): Box | null {
  const n = (text ?? "").split(",").map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2]! <= 0 || n[3]! <= 0) return null;
  return { left: n[0]!, top: n[1]!, width: n[2]!, height: n[3]! };
}

type Carry = { key: string; el: HTMLCanvasElement; from: Box; timer: number };
let carry: Carry | null = null;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function remove(c: Carry) {
  window.clearTimeout(c.timer);
  c.el.remove();
  if (carry === c) carry = null;
}

// Fade the copy out where it is, then remove it (also without animation frames).
function giveUp(c: Carry) {
  if (carry === c) carry = null;
  c.el.style.transition = `opacity ${GIVE_UP_FADE_MS}ms ease-out`;
  c.el.style.opacity = "0";
  window.setTimeout(() => remove(c), GIVE_UP_FADE_MS + 50);
}

// Is a carried print waiting for this player's dashboard?
export const carryWaiting = (key: string) => carry?.key === key;

// Landing side: copy the print's region of `source` (crop in CSS pixels inside it) into a fixed
// canvas at the same place on screen. Returns whether a carry started.
export function startCarry(key: string, source: HTMLCanvasElement, crop: Box): boolean {
  if (carry) remove(carry);
  if (reducedMotion()) return false;
  const at = source.getBoundingClientRect();
  if (at.width <= 0 || source.width <= 0) return false;
  const from: Box = { left: at.left + crop.left, top: at.top + crop.top, width: crop.width, height: crop.height };
  if (!canStart(from, window.innerWidth, window.innerHeight)) return false;
  const k = source.width / at.width; // canvas pixels per CSS pixel
  const el = document.createElement("canvas");
  el.width = Math.max(1, Math.round(crop.width * k));
  el.height = Math.max(1, Math.round(crop.height * k));
  const ctx = el.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(source, Math.round(crop.left * k), Math.round(crop.top * k), el.width, el.height, 0, 0, el.width, el.height);
  el.setAttribute("aria-hidden", "true");
  el.dataset.printCarry = key;
  Object.assign(el.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${crop.width}px`,
    height: `${crop.height}px`,
    transformOrigin: "0 0",
    transform: carryTransform(from, from),
    background: "var(--color-bone)",
    pointerEvents: "none",
    zIndex: "50",
  });
  document.body.appendChild(el);
  const c: Carry = { key, el, from, timer: 0 };
  c.timer = window.setTimeout(() => giveUp(c), CARRY_WAIT_MS);
  carry = c;
  return true;
}

// Where an element is once its entrance has ended. The dashboard's sections rise into place as
// they appear; the copy needs to know where they END up, so those animations are finished now.
function settledBox(el: Element): Box {
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    for (const a of node.getAnimations?.() ?? []) a.finish();
  }
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

// Dashboard side: the real print (`print`) has drawn. The copy moves onto it, or is pressed into
// the plate's strip when the print is (nearly) off screen, and fades.
export function landCarry(key: string, print: HTMLElement): void {
  const c = carry;
  if (!c || c.key !== key) return;
  carry = null;
  window.clearTimeout(c.timer);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const line = document.querySelector("[data-print-line]");
  const to = reducedMotion() || typeof c.el.animate !== "function" ? null : ([print, line].flatMap((el) => (el ? [settledBox(el)] : [])).find((b) => canLand(b, vw, vh)) ?? null);
  if (!to) {
    giveUp(c);
    return;
  }
  const start = carryTransform(c.from, c.from);
  const end = carryTransform(c.from, to);
  const anim = c.el.animate(
    [
      { transform: start, opacity: 1 },
      { transform: end, opacity: 1, offset: CARRY_HOLD },
      { transform: end, opacity: 0 },
    ],
    // Slow at both ends: the eye has to see the print go, not just find it gone.
    { duration: CARRY_MS, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
  );
  anim.onfinish = () => remove(c);
  // Without animation frames the animation never finishes: the timer removes the copy anyway.
  c.timer = window.setTimeout(() => remove(c), CARRY_MS + 200);
}
