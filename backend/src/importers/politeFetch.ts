import { RetryableError } from "../jobs/errors.js";
import { logger } from "../lib/logger.js";
import { sleep as realSleep, type Sleep } from "../lib/sleep.js";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface PoliteClientOptions {
  name: string;
  userAgent: string;
  // Waits after each 429, in order. Lichess: [60_000] ("wait a full minute"). When they run
  // out, we throw RetryableError and the job queue takes over with its own backoff.
  rateLimitWaitsMs: number[];
  // Waits before retrying a network error or 5xx.
  errorWaitsMs?: number[];
  // Whole-request timeout for JSON calls; idle (no bytes received) timeout for streams.
  timeoutMs?: number;
  fetch?: FetchFn;
  sleep?: Sleep;
  now?: () => number;
}

export interface JsonResult<T> {
  status: number; // 200, 304 or 404; other statuses throw
  data?: T;
  etag?: string;
}

interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  // GET unless set. Lichess's "export games by IDs" is a POST with the ids as a text body.
  method?: "GET" | "POST";
  body?: string;
}

// A client for one external site that sends one request at a time, process-wide.
// Requests wait their turn on a promise chain (a tiny mutex). A 429 blocks the whole site,
// not just the request that got it, until the wait is over.
export function createPoliteClient({
  name,
  userAgent,
  rateLimitWaitsMs,
  errorWaitsMs = [1_000, 2_000],
  timeoutMs = 15_000,
  fetch = globalThis.fetch,
  sleep = realSleep,
  now = Date.now,
}: PoliteClientOptions) {
  let tail: Promise<unknown> = Promise.resolve();
  let blockedUntil = 0;

  // Runs task after every earlier task on this client has finished, success or failure.
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  }

  // One request with 429 and error retries. Must be called inside serial().
  // attemptSignal() is called per attempt, so a timeout never counts the time spent waiting.
  async function send(url: string, options: RequestOptions, attemptSignal: () => AbortSignal): Promise<Response> {
    let rateLimitHits = 0;
    let errors = 0;
    for (;;) {
      const wait = blockedUntil - now();
      if (wait > 0) await sleep(wait, options.signal);

      let res: Response;
      try {
        res = await fetch(url, {
          method: options.method ?? "GET",
          headers: { "User-Agent": userAgent, ...options.headers },
          body: options.body,
          signal: attemptSignal(),
        });
      } catch (err) {
        // A job abort (lease lost, shutdown) is not a network error: let it through as is.
        if (options.signal?.aborted) throw options.signal.reason;
        if (errors < errorWaitsMs.length) {
          logger.warn(`${name}: request failed, retrying`, { url, error: String(err) });
          await sleep(errorWaitsMs[errors++], options.signal);
          continue;
        }
        throw new RetryableError(`${name} could not be reached`);
      }

      if (res.status === 429) {
        await res.body?.cancel();
        const waitMs = Math.max(rateLimitWaitsMs[Math.min(rateLimitHits, rateLimitWaitsMs.length - 1)], retryAfterMs(res));
        blockedUntil = now() + waitMs;
        logger.warn(`${name}: 429, waiting`, { url, waitMs });
        if (rateLimitHits++ < rateLimitWaitsMs.length) continue;
        throw new RetryableError(`${name} is rate limiting us`, waitMs);
      }

      if (res.status >= 500) {
        await res.body?.cancel();
        if (errors < errorWaitsMs.length) {
          await sleep(errorWaitsMs[errors++], options.signal);
          continue;
        }
        throw new RetryableError(`${name} is having problems (HTTP ${res.status})`);
      }
      return res;
    }
  }

  // GET a JSON resource. 304 and 404 are returned (the caller decides what they mean);
  // other 4xx are unexpected and throw.
  function getJson<T>(url: string, options: RequestOptions = {}): Promise<JsonResult<T>> {
    return serial(async () => {
      const res = await send(url, { ...options, headers: { Accept: "application/json", ...options.headers } }, () =>
        combine(options.signal, AbortSignal.timeout(timeoutMs)),
      );
      const etag = res.headers.get("etag") ?? undefined;
      if (res.status === 304 || res.status === 404) {
        await res.body?.cancel();
        return { status: res.status, etag };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new RetryableError(`${name} returned HTTP ${res.status}`);
      }
      try {
        return { status: res.status, etag, data: (await res.json()) as T };
      } catch (err) {
        if (options.signal?.aborted) throw options.signal.reason;
        throw new RetryableError(`${name} sent a response we could not read`);
      }
    });
  }

  // GET a newline-delimited stream (NDJSON) and hand each non-empty line to onLine, as it
  // arrives. The site stays locked until the stream ends, so nothing else is sent meanwhile.
  // Returns the status; on 404 onLine is never called.
  function streamLines(
    url: string,
    onLine: (line: string) => Promise<void> | void,
    options: RequestOptions = {},
  ): Promise<number> {
    return serial(async () => {
      // Idle timeout instead of a total one: a 200-game export can legitimately take a while,
      // but it should never go silent for timeoutMs.
      let idle = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(new Error("idle timeout")), timeoutMs);
      };
      try {
        const res = await send(url, options, () => {
          idle = new AbortController();
          touch();
          return combine(options.signal, idle.signal);
        });
        if (res.status === 404) {
          await res.body?.cancel();
          return 404;
        }
        if (!res.ok || !res.body) {
          await res.body?.cancel();
          throw new RetryableError(`${name} returned HTTP ${res.status}`);
        }
        touch();
        const decoder = new TextDecoder();
        let buffered = "";
        try {
          for await (const chunk of res.body) {
            touch();
            // A chunk can end in the middle of a line (or a multi-byte character):
            // keep the unfinished part for the next chunk.
            buffered += decoder.decode(chunk, { stream: true });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) if (line.trim()) await onLine(line);
          }
        } catch (err) {
          if (options.signal?.aborted) throw options.signal.reason;
          if (err instanceof RetryableError) throw err;
          if (idle.signal.aborted) throw new RetryableError(`${name} stopped sending data`);
          throw err;
        }
        buffered += decoder.decode();
        if (buffered.trim()) await onLine(buffered);
        return res.status;
      } finally {
        clearTimeout(idleTimer);
      }
    });
  }

  return { getJson, streamLines };
}

export type PoliteClient = ReturnType<typeof createPoliteClient>;

function combine(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

// Retry-After in seconds, if the site sent one. We never wait less than our own minimum.
function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export function userAgent(contactEmail: string): string {
  return `Blunderprint/1.0 (contact: ${contactEmail})`;
}
