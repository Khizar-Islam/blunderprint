import type { FetchFn } from "../src/importers/politeFetch.js";

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

// A fetch stand-in for tests: records every call and answers with whatever respond returns.
export function recordingFetch(
  respond: (url: string, call: number, signal?: AbortSignal) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, signal: init.signal ?? undefined });
    return respond(url, calls.length - 1, init.signal ?? undefined);
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

export function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : "", { status, headers });
}

// A streamed body delivered in exactly these chunks, so tests can split lines (and characters)
// across chunk boundaries the way a real network does. Chunks are handed out only as they're
// read, and once the request's signal aborts (e.g. an idle timeout) the body errors, like a
// real connection being cut.
export function chunkedResponse(chunks: (string | Uint8Array)[], signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (signal?.aborted) return controller.error(signal.reason);
        const chunk = queue.shift();
        if (chunk === undefined) return controller.close();
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
