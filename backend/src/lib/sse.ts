import type { Response } from "express";

export interface SseStream {
  // One SSE message. `id` becomes EventSource's lastEventId (we use the job's rev).
  send(event: string, data: unknown, id?: number): void;
  // End the response. Safe to call twice.
  close(): void;
  // Runs once when the stream ends, whether we closed it or the client went away.
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

// Every open stream, so shutdown can end them all instead of waiting on idle connections.
const open = new Set<SseStream>();

// Server-Sent Events: a normal HTTP response kept open, written in "event:/id:/data:" blocks
// separated by a blank line. The browser's EventSource parses them and reconnects on its own.
export function openSse(res: Response, { heartbeatMs = 15_000 } = {}): SseStream {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // no-transform: proxies must not compress or buffer the stream.
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Nginx-style proxies otherwise buffer the response until it ends.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  // Ask EventSource to wait 3 s before reconnecting after a drop.
  res.write("retry: 3000\n\n");

  let closed = false;
  const closeHandlers: Array<() => void> = [];

  // A comment line (starts with ":") every 15 s: EventSource ignores it, but it keeps proxies
  // (Cloudflare, Render) from cutting a quiet connection as idle.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    open.delete(stream);
    for (const fn of closeHandlers) fn();
  }

  const stream: SseStream = {
    send(event, data, id) {
      if (closed) return;
      res.write(`event: ${event}\n${id !== undefined ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      cleanup();
      res.end();
    },
    onClose(fn) {
      if (closed) fn();
      else closeHandlers.push(fn);
    },
    get closed() {
      return closed;
    },
  };

  open.add(stream);
  // The client closed the tab or EventSource.close(): stop the heartbeat and unsubscribe.
  // res "close" (not req "close") is the reliable "connection is gone" signal in Node 22.
  res.on("close", cleanup);
  return stream;
}

// For graceful shutdown. Returns how many streams were open.
export function closeAllSse(): number {
  const count = open.size;
  for (const stream of [...open]) stream.close();
  return count;
}
