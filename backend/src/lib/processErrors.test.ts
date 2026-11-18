import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { installProcessErrorHandlers } from "./processErrors.js";

function setup(t: TestContext, shutdown?: (reason: string, code: number) => Promise<void>) {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => void lines.push(line));
  t.mock.method(console, "error", (line: string) => void lines.push(line));
  const proc = new EventEmitter();
  const server = new EventEmitter();
  const shutdowns: Array<[string, number]> = [];
  const exits: number[] = [];
  installProcessErrorHandlers({
    proc: proc as unknown as Pick<NodeJS.Process, "on">,
    server,
    shutdown: shutdown ?? (async (reason, code) => void shutdowns.push([reason, code])),
    exit: (code) => void exits.push(code),
  });
  return { proc, server, shutdowns, exits, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test("an unhandled rejection is one JSON line with the stack, then a graceful shutdown with code 1", (t) => {
  const s = setup(t);
  s.proc.emit("unhandledRejection", new Error("forgot to await"));
  assert.equal(s.lines.length, 1);
  assert.ok(!s.lines[0]!.includes("\n"));
  const line = s.parsed()[0]!;
  assert.deepEqual([line.level, line.msg, line.error], ["error", "unhandled_rejection", "forgot to await"]);
  assert.match(String(line.stack), /forgot to await/);
  assert.deepEqual(s.shutdowns, [["unhandledRejection", 1]]);
  assert.deepEqual(s.exits, [], "the shutdown exits, not the handler");
});

test("a rejection with something that isn't an Error is still logged", (t) => {
  const s = setup(t);
  s.proc.emit("unhandledRejection", "just a string");
  const line = s.parsed()[0]!;
  assert.equal(line.error, "just a string");
  assert.equal(line.stack, undefined);
});

test("an uncaught exception is one JSON line, then a graceful shutdown with code 1", (t) => {
  const s = setup(t);
  s.proc.emit("uncaughtException", new TypeError("x is not a function"));
  const line = s.parsed()[0]!;
  assert.deepEqual([line.level, line.msg, line.error], ["error", "uncaught_exception", "x is not a function"]);
  assert.deepEqual(s.shutdowns, [["uncaughtException", 1]]);
});

test("if the shutdown itself fails, the process still exits with 1", async (t) => {
  const s = setup(t, async () => {
    throw new Error("db already gone");
  });
  s.proc.emit("uncaughtException", new Error("first"));
  await tick();
  assert.deepEqual(s.exits, [1]);
  const failed = s.parsed().find((l) => l.msg === "shutdown_failed")!;
  assert.deepEqual([failed.reason, failed.error], ["uncaughtException", "db already gone"]);
});

test("a server error (port taken) is logged with its code and exits 1 without a shutdown", (t) => {
  const s = setup(t);
  s.server.emit("error", Object.assign(new Error("listen EADDRINUSE: address already in use :::5000"), { code: "EADDRINUSE" }));
  const line = s.parsed()[0]!;
  assert.deepEqual([line.msg, line.code], ["server_error", "EADDRINUSE"]);
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.shutdowns, []);
});
