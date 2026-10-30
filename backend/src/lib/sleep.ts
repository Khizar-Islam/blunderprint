export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

// setTimeout as a promise that rejects early when the signal aborts (job lost its lease,
// server shutting down), so nobody sits out a 60 s wait for nothing.
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
