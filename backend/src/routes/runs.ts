import { Router } from "express";
import { z } from "zod";
import { friendly } from "../agent/friendly.js";
import { toPublicReport } from "../agent/reportStore.js";
import { runEvents, toPublicRun, type RunEvent } from "../agent/runs.js";
import { AgentRun } from "../db/models/agentRun.js";
import { Report } from "../db/models/report.js";
import { openSse, type SseStream } from "../lib/sse.js";
import { parseOr400 } from "../lib/validate.js";
import { HttpError } from "../middleware/errorHandler.js";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i);
const isFinished = (status: string) => status === "done" || status === "failed";

// GET /api/runs/:id/stream: a coach run's live trace over SSE. The same contract as the job
// stream (routes/jobs.ts):
//   - subscribe first, buffer, read the run, send it as `snapshot`, then only events with a rev
//     greater than the snapshot's: nothing lost or repeated in between;
//   - every event's id is the run's rev; retry 3000; a heartbeat comment every 15 s;
//   - the stream ends after `done` or `failed`; a reconnect always starts with a fresh snapshot.
// Events: snapshot / status / done / failed carry the whole public run (done: with the report);
// `step` carries only { step }, since the snapshot already had the earlier steps.
export function runsRouter({ heartbeatMs }: { heartbeatMs?: number } = {}): Router {
  const router = Router();

  router.get("/runs/:id/stream", async (req, res) => {
    const id = parseOr400(objectId, req.params.id, "Invalid run id");

    let stream: SseStream | null = null;
    let sentRev = -1;
    const buffered: RunEvent[] = [];
    const deliver = (event: RunEvent) => {
      if (!stream || event.rev <= sentRev) return;
      sentRev = event.rev;
      if (event.type === "step") {
        stream.send("step", { step: event.step }, event.rev);
        return;
      }
      stream.send(event.type, event.run, event.rev);
      if (isFinished(event.run.status)) stream.close();
    };
    const unsubscribe = runEvents.subscribe(id, (event) => (stream ? deliver(event) : buffered.push(event)));

    let run;
    let report = null;
    try {
      run = await AgentRun.findById(id);
      // A finished run's snapshot carries its report, if it's still the kept one.
      if (run?.status === "done" && run.reportId) {
        const doc = await Report.findById(run.reportId);
        report = doc ? toPublicReport(doc) : null;
      }
    } catch (err) {
      unsubscribe();
      throw err;
    }
    if (!run) {
      unsubscribe();
      const f = friendly("run_not_found");
      throw new HttpError(404, f.message, f.code);
    }

    stream = openSse(res, { heartbeatMs });
    stream.onClose(unsubscribe);
    const snapshot = toPublicRun(run, report);
    sentRev = snapshot.rev;
    stream.send("snapshot", snapshot, snapshot.rev);
    if (isFinished(snapshot.status)) {
      stream.close();
      return;
    }
    for (const event of buffered) deliver(event);
  });

  return router;
}
