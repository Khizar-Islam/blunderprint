import type { QueryFilter } from "mongoose";
import type { JobFields, JobType } from "../db/models/job.js";
import { createCoachRuntime, type CoachRuntime } from "../agent/coach.js";
import type { Model } from "../agent/model.js";
import { syncRunExpiry } from "../agent/runExpiry.js";
import type { Env } from "../config/env.js";
import { createChessComImporter } from "../importers/chesscom.js";
import { createLichessImporter } from "../importers/lichess.js";
import { createPoliteClient, userAgent } from "../importers/politeFetch.js";
import { createAskHandler } from "./handlers/ask.js";
import { createExtractHandler } from "./handlers/extract.js";
import { createImportHandler } from "./handlers/import.js";
import { createReportHandler } from "./handlers/report.js";
import { createQueue } from "./queue.js";
import type { Handlers } from "./worker.js";

export type JobSystemEnv = Pick<Env, "CONTACT_EMAIL" | "MAX_GAMES_PER_PLAYER"> &
  Partial<Pick<Env, "demoPlayers">> &
  Parameters<typeof createCoachRuntime>[0];

// Builds the queue, the coach runtime and every job handler from config. One polite client per
// site, shared by everything in the process, so "one request at a time" holds across all jobs.
export function createJobSystem(env: JobSystemEnv, { model }: { model?: Model } = {}) {
  const ua = userAgent(env.CONTACT_EMAIL);
  const chesscom = createPoliteClient({ name: "Chess.com", userAgent: ua, rateLimitWaitsMs: [5_000, 10_000] });
  // Lichess: "waiting one minute before retrying will be sufficient" (API docs, Rate limiting).
  const lichess = createPoliteClient({ name: "Lichess", userAgent: ua, rateLimitWaitsMs: [60_000] });

  const queue = createQueue();
  const coach: CoachRuntime = createCoachRuntime(env, { model });
  const handlers: Handlers = {
    import: createImportHandler({
      importers: { chesscom: createChessComImporter(chesscom), lichess: createLichessImporter(lichess) },
      maxGames: env.MAX_GAMES_PER_PLAYER,
      queue,
    }),
    extract: createExtractHandler(),
    // A new report for a demo player: keep its run (the trace) and date the one it replaced.
    report: createReportHandler(coach, { afterSave: () => syncRunExpiry(env.demoPlayers ?? []) }),
    ask: createAskHandler(coach),
  };
  // The two worker lanes (server.ts starts one worker per lane). The coach lane runs reports and
  // questions (Stage 6), one at a time, and only for this process's model (see handlers/report.ts).
  const lanes: Record<"main" | "coach", QueryFilter<JobFields>> = {
    main: { type: { $in: ["import", "extract"] as JobType[] } },
    coach: { type: { $in: ["report", "ask"] as JobType[] }, "payload.model": coach.modelName },
  };
  return { queue, handlers, coach, lanes };
}
