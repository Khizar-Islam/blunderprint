import { test } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { afterCursor, decodeCursor, encodeCursor } from "./cursor.js";

test("a cursor round-trips playedAt and _id", () => {
  const cursor = { playedAt: new Date("2026-10-30T12:34:56.789Z"), id: new Types.ObjectId() };
  const decoded = decodeCursor(encodeCursor(cursor));
  assert.equal(decoded.playedAt.getTime(), cursor.playedAt.getTime());
  assert.equal(String(decoded.id), String(cursor.id));
});

test("malformed cursors are a 400, never a 500", () => {
  const bad = [
    "",
    "%%%",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ t: -1, id: "0123456789abcdef01234567" })).toString("base64url"),
    Buffer.from(JSON.stringify({ t: 1, id: { $gt: "" } })).toString("base64url"),
  ];
  for (const token of bad) {
    assert.throws(() => decodeCursor(token), (err: { statusCode?: number }) => err.statusCode === 400, token);
  }
});

test("afterCursor bounds playedAt and breaks ties by _id", () => {
  const playedAt = new Date("2026-10-30T00:00:00Z");
  const id = new Types.ObjectId();
  assert.deepEqual(afterCursor({ playedAt, id }), {
    playedAt: { $lte: playedAt },
    $or: [{ playedAt: { $lt: playedAt } }, { playedAt, _id: { $lt: id } }],
  });
});
