import type { QueryFilter } from "mongoose";
import type { JobFields, JobType } from "../db/models/job.js";
import { createCoachRuntime, type CoachRuntime } from "../agent/coach.js";
import type { Model } from "../agent/model.js";
import type { Env } from "../config/env.js";
import { createChessComImporter } from "../importers/chesscom.js";
import { createLichessImporter } from "../importers/lichess.js";
import { createPoliteClient, userAgent } from "../importers/politeFetch.js";
import { createExtractHandler } from "./handlers/extract.js";
import { createImportHandler } from "./handlers/import.js";
import { createReportHandler } from "./handlers/report.js";
import { createQueue } from "./queue.js";
import type { Handlers } from "./worker.js";

export type JobSystemEnv = Pick<Env, "CONTACT_EMAIL" | "MAX_GAMES_PER_PLAYER"> & Parameters<typeof createCoachRuntime>[0];

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
    report: createReportHandler(coach),
  };
  // The two worker lanes (server.ts starts one worker per lane). Reports only take jobs for
  // this process's model (see handlers/report.ts).
  const lanes: Record<"main" | "coach", QueryFilter<JobFields>> = {
    main: { type: { $in: ["import", "extract"] as JobType[] } },
    coach: { type: "report" as JobType, "payload.model": coach.modelName },
  };
  return { queue, handlers, coach, lanes };
}
