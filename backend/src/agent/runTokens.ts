import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Types } from "mongoose";
import { AgentRun, MAX_RUN_TOKENS } from "../db/models/agentRun.js";

// Secret tokens for "Ask the coach" runs (Stage 6 chunk B). A question can be private, and run
// ids (ObjectIds) are partly predictable, so an ask run can only be streamed with a token.
//
// - Every requester gets their OWN random token (crypto.randomUUID), in the 202 of POST /ask
//   and nowhere else: the asker, and anyone who asks the same question while it runs (they join
//   the same run, for free).
// - The run stores only SHA-256 hashes of them (agentRuns.tokenHashes), at most MAX_RUN_TOKENS:
//   someone reading the database can't stream a run with what's stored.
// - The stream (routes/runs.ts) hashes the token it's given and compares it, in constant time,
//   with every stored hash. A missing or wrong token gets the same 404 as a run that doesn't
//   exist, so a guessed id tells nothing.
// - Request logs drop the query string (middleware/requestId.ts), so the token is never logged.

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export function newRunToken(): { token: string; hash: string } {
  const token = randomUUID();
  return { token, hash: hashToken(token) };
}

// Does the token match one of the stored hashes? Every hash is compared (no early exit), each in
// constant time, so the timing doesn't reveal which one matched or how much of it.
export function tokenMatches(hashes: readonly string[] | null | undefined, token: unknown): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 100 || !hashes?.length) return false;
  const given = Buffer.from(hashToken(token), "hex");
  let match = false;
  for (const h of hashes) {
    const stored = Buffer.from(h, "hex");
    if (stored.length === given.length && timingSafeEqual(stored, given)) match = true;
  }
  return match;
}

// A new token for someone joining an active ask run. null when the run already has
// MAX_RUN_TOKENS (the caller answers 503 busy) or isn't active any more. One atomic update: the
// filter checks there's room ("tokenHashes.<max-1>" doesn't exist yet), so concurrent joins
// can't push it past the cap; $slice is a second guard.
export async function addRunToken(runId: Types.ObjectId | string): Promise<string | null> {
  const { token, hash } = newRunToken();
  const res = await AgentRun.updateOne(
    { _id: runId, kind: "ask", status: { $in: ["queued", "running"] }, [`tokenHashes.${MAX_RUN_TOKENS - 1}`]: { $exists: false } },
    { $push: { tokenHashes: { $each: [hash], $slice: MAX_RUN_TOKENS } } },
    { timestamps: false },
  );
  return res.modifiedCount === 1 ? token : null;
}
