import { Types } from "mongoose";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";

// Cursor pagination: instead of "skip 40", the client sends back the position of the last game
// it saw (playedAt + _id), and the next page starts strictly after it. That stays fast however
// deep you page, and games imported mid-scroll don't shift pages around the way skip does.
// The token is base64url JSON so clients treat it as opaque and never build one themselves.

export interface Cursor {
  playedAt: Date;
  id: Types.ObjectId;
}

const cursorShape = z.object({
  t: z.number().int().nonnegative(),
  id: z.string().regex(/^[0-9a-f]{24}$/),
});

export function encodeCursor({ playedAt, id }: Cursor): string {
  return Buffer.from(JSON.stringify({ t: playedAt.getTime(), id: String(id) })).toString("base64url");
}

export function decodeCursor(token: string): Cursor {
  try {
    const { t, id } = cursorShape.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    return { playedAt: new Date(t), id: new Types.ObjectId(id) };
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
}

// "Strictly after the cursor" in newest-first order. playedAt ≤ t gives one plain index scan
// that starts at the cursor; the $or then breaks ties between games played at the same instant
// by _id. Without the playedAt ≤ t, MongoDB 8.0 still uses the index, as two scans merged in
// order (SORT_MERGE). Both read only about one page of keys: docs/explain/games-pagination.json.
export function afterCursor({ playedAt, id }: Cursor) {
  return {
    playedAt: { $lte: playedAt },
    $or: [{ playedAt: { $lt: playedAt } }, { playedAt, _id: { $lt: id } }],
  };
}
