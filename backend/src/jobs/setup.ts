import type { Env } from "../config/env.js";
import { createChessComImporter } from "../importers/chesscom.js";
import { createLichessImporter } from "../importers/lichess.js";
import { createPoliteClient, userAgent } from "../importers/politeFetch.js";
import { createImportHandler } from "./handlers/import.js";
import { createQueue } from "./queue.js";
import type { Handlers } from "./worker.js";

// Builds the queue and every job handler from config. One polite client per site, shared by
// everything in the process, so "one request at a time" holds across all jobs.
export function createJobSystem(env: Pick<Env, "CONTACT_EMAIL" | "MAX_GAMES_PER_PLAYER">) {
  const ua = userAgent(env.CONTACT_EMAIL);
  const chesscom = createPoliteClient({ name: "Chess.com", userAgent: ua, rateLimitWaitsMs: [5_000, 10_000] });
  // Lichess: "waiting one minute before retrying will be sufficient" (API docs, Rate limiting).
  const lichess = createPoliteClient({ name: "Lichess", userAgent: ua, rateLimitWaitsMs: [60_000] });

  const queue = createQueue();
  const handlers: Handlers = {
    import: createImportHandler({
      importers: { chesscom: createChessComImporter(chesscom), lichess: createLichessImporter(lichess) },
      maxGames: env.MAX_GAMES_PER_PLAYER,
    }),
  };
  return { queue, handlers };
}
