// A minimal SSE reader for tests: fetch the stream and parse it block by block, the way
// EventSource would. Comment lines (": ping") are kept so heartbeats can be tested too.

export interface SseMessage {
  event?: string;
  id?: string;
  data?: unknown;
  comment?: string;
  retry?: number;
}

export async function openSseClient(url: string) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  function parse(block: string): SseMessage {
    const message: SseMessage = {};
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) message.comment = line.slice(1).trim();
      else if (line.startsWith("event: ")) message.event = line.slice(7);
      else if (line.startsWith("id: ")) message.id = line.slice(4);
      else if (line.startsWith("data: ")) message.data = JSON.parse(line.slice(6));
      else if (line.startsWith("retry: ")) message.retry = Number(line.slice(7));
    }
    return message;
  }

  // The next message, or null once the server has ended the stream.
  async function next(timeoutMs = 2_000): Promise<SseMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return parse(block);
      }
      if (ended) return null;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Timed out waiting for an SSE message");
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out waiting for an SSE message")), left);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) ended = true;
      else buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  // Skips the "retry:" preamble and heartbeats: the next real event.
  async function nextEvent(timeoutMs?: number): Promise<SseMessage | null> {
    while (true) {
      const message = await next(timeoutMs);
      if (!message || message.event) return message;
    }
  }

  return { res, next, nextEvent, close: () => controller.abort() };
}
