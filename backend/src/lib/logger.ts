import { AsyncLocalStorage } from "node:async_hooks";

// One-line JSON logs, so Render's log viewer can be searched by field.
//
// Conventions (Stage 8):
// - `msg` is a fixed snake_case event name ("job_started", "ask_done"). Values never go into the
//   name: they are fields, so one event can be searched for whatever its values were.
// - Durations are milliseconds in a field ending in "ms"/"Ms"; `error` is the error's message
//   (errorMessage below), `stack` only for unexpected errors.
// - Never a secret, a raw IP, an ask-run token or a visitor's question (CLAUDE.md §13).
type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

// Log context: fields added to every line logged "inside" a piece of work, without passing them
// down by hand. AsyncLocalStorage (Node built-in) keeps one value per chain of async calls: what
// runs inside withLogContext(fields, fn), including everything fn awaits, timers it starts and
// promise callbacks it attaches, sees those fields; other jobs running at the same time see
// their own. The worker wraps each job in { jobId } and the coach handlers add { runId }, so the
// importers', the agent loop's and the tools' lines can be tied to their job and run.
// Not used for requests: Express's body parser continues from the socket's "data" events, which
// are outside the context, so request handlers pass res.locals.requestId themselves.
const context = new AsyncLocalStorage<Fields>();

export function withLogContext<T>(fields: Fields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

// Runs fn with NO context fields. For lines that aren't about the job that happens to be running
// when they are logged: an event emitted from inside a job runs its listeners in that job's
// context. Two such places exist: the request line of an SSE stream that a job's own event ends,
// and Mongoose's connection events, which can fire from a socket the pool opened during a job.
export function withoutLogContext<T>(fn: () => T): T {
  return context.run({}, fn);
}

// The message of anything thrown (a non-Error is turned into text).
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function write(level: Level, msg: string, fields: Fields = {}): void {
  // A call's own fields win over the context's. A field named level, time or msg is dropped,
  // so it can never overwrite the line's own.
  const { level: _level, time: _time, msg: _msg, ...rest } = { ...context.getStore(), ...fields };
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...rest });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};
