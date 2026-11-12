// Shared by the ui-*.mjs checks (Stage 7): a minimal Chrome DevTools Protocol client (headless
// Chrome, one page, Node's built-in WebSocket: no extra dependencies), the pages under test and
// small helpers. Not run on its own.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
export const BASE = "http://localhost:3000";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(port = 9333) {
  const dir = join(tmpdir(), `blunderprint-chrome-${port}`); // a throwaway profile, outside the repo
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--window-size=1280,900", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let list;
  for (let i = 0; i < 50; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(200);
  }
  const target = list.find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) (listeners.get(msg.method) ?? []).forEach((f) => f(msg.params));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const on = (method, f) => listeners.set(method, [...(listeners.get(method) ?? []), f]);
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const navigate = async (url) => {
    const loaded = new Promise((r) => on("Page.loadEventFired", r));
    await send("Page.navigate", { url });
    await loaded;
  };
  const viewport = (width, height = 900, mobile = false) =>
    send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  const screenshot = async (path) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  };
  const close = () => {
    ws.close();
    proc.kill();
  };
  return { send, on, evaluate, navigate, viewport, screenshot, close };
}

// Waits until `expression` is truthy in the page (polling), or throws after `ms`.
export async function waitFor(page, expression, ms = 30_000, label = expression) {
  const start = Date.now();
  for (;;) {
    try {
      if (await page.evaluate(expression)) return Date.now() - start;
    } catch {}
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

// The pages under test (the frozen demo player), with what "loaded" means on each.
const demo = { username: "DrNykterstein", game: "6ae4e99e5599b736e9db13d1", ply: 35 };
// Clicks the first enabled suggested-question chip once, then is true when an answer is shown.
export const ASK_READY = `(() => {
  if (!document.querySelector('#ask-heading')) return false;
  if (!window.__asked) {
    const chip = document.querySelector('[data-chip]:not([disabled])');
    if (!chip) return false;
    window.__asked = 1;
    chip.click();
  }
  return !!document.querySelector('article[data-answer]');
})()`;
export const PAGES = [
  { name: "landing", path: "/", ready: `!!document.querySelector('canvas')` },
  { name: "dashboard", path: `/p/lichess/${demo.username}`, ready: `!!document.querySelector('[aria-label^="Blunderprint:"]') && document.querySelectorAll('ol[aria-label="Games, newest first"] > li').length > 0` },
  { name: "coach", path: `/p/lichess/${demo.username}/coach`, ready: `document.querySelectorAll('article').length > 0` },
  { name: "review", path: `/p/lichess/${demo.username}/game/${demo.game}?ply=${demo.ply}`, ready: `!!document.querySelector('[role=slider]') && !!document.querySelector('[aria-label="Moves"] button')` },
  // "Ask the coach" (Stage 6): the coach page after a click on the first chip that can be clicked,
  // once its answer is on the page. On live (and on a local API with AI_ENABLED=false) the demo's
  // chips are pre-answered, so it's instant and free; a local API with COACH_MODEL=scripted streams
  // a scripted answer first (free too). The click is a plain JS click (not "user input" for CLS):
  // ui-cls.mjs's "ask" scenario clicks with real mouse events instead.
  { name: "coach-ask", path: `/p/lichess/${demo.username}/coach`, ready: ASK_READY },
];

// Scrolls to the bottom in steps (so every scroll-triggered reveal fires), then back to the top.
export async function scrollThrough(page, stepPx = 500, pauseMs = 120) {
  const h = await page.evaluate("document.documentElement.scrollHeight");
  for (let y = 0; y <= h; y += stepPx) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(pauseMs);
  }
  await page.evaluate("window.scrollTo(0, 0)");
}
