import { sleep as realSleep, type Sleep } from "../lib/sleep.js";

// Keeps the process's model calls under the provider's per-minute limits (env GEMINI_RPM,
// GEMINI_TPM). ONE pacer per process, shared by every coach run, because Google counts per
// project: two reports running at once share the same 15 requests a minute.
//
// - Requests: calls start at least 60 000 / RPM ms apart (4 s at 15 RPM). Spacing them evenly
//   is simpler than counting a sliding window and never bursts into a 429.
// - Tokens: a call waits while the tokens of the calls started in the last 60 s, plus this
//   call's estimate, would pass TPM. Each estimate is replaced by the real count afterwards.
// - After a 429, backoff() holds every caller until Google's suggested time has passed.
//
// Callers queue in order (a promise chain): the first to ask is the first to go.

export interface PacerOptions {
  rpm: number;
  tpm: number;
  now?: () => number;
  sleep?: Sleep;
}

export interface Slot {
  // Replace this call's estimate with the tokens it really used.
  settle(tokens: number): void;
}

const WINDOW_MS = 60_000;

export function createPacer({ rpm, tpm, now = Date.now, sleep = realSleep }: PacerOptions) {
  const intervalMs = Math.ceil(WINDOW_MS / rpm);
  let nextStartAt = 0;
  let blockedUntil = 0;
  const recent: { at: number; tokens: number }[] = [];
  let queue: Promise<void> = Promise.resolve();

  const tokensInWindow = (t: number) => {
    while (recent.length && recent[0]!.at <= t - WINDOW_MS) recent.shift();
    return recent.reduce((sum, r) => sum + r.tokens, 0);
  };

  // When a call with this estimate could start, given the token window. A single estimate
  // bigger than the whole TPM can't ever fit: it goes as soon as the window is empty.
  const tokenReadyAt = (t: number, estimate: number): number => {
    let used = tokensInWindow(t);
    if (used + estimate <= tpm) return t;
    for (const r of recent) {
      used -= r.tokens;
      if (used + estimate <= tpm || used === 0) return r.at + WINDOW_MS;
    }
    return t;
  };

  async function waitTurn(estimate: number, signal?: AbortSignal): Promise<Slot> {
    for (;;) {
      const t = now();
      const readyAt = Math.max(nextStartAt, blockedUntil, tokenReadyAt(t, estimate));
      if (readyAt <= t) break;
      await sleep(readyAt - t, signal);
    }
    const start = now();
    nextStartAt = start + intervalMs;
    const entry = { at: start, tokens: estimate };
    recent.push(entry);
    return { settle: (tokens) => void (entry.tokens = Math.max(0, tokens)) };
  }

  return {
    intervalMs,
    // Waits for this call's turn. If the signal aborts while waiting, this caller leaves the
    // queue (the promise rejects) and the callers behind it carry on.
    acquire(estimate: number, signal?: AbortSignal): Promise<Slot> {
      const turn = queue.then(() => waitTurn(estimate, signal));
      queue = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    },
    // A 429: nobody calls again before `ms` from now.
    backoff(ms: number): void {
      blockedUntil = Math.max(blockedUntil, now() + ms);
    },
  };
}

export type Pacer = ReturnType<typeof createPacer>;
