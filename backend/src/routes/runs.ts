import { Router } from "express";
import { z } from "zod";
import { publicAnswerOf } from "../agent/answerStore.js";
import { friendly } from "../agent/friendly.js";
import { publicReportOf } from "../agent/reportStore.js";
import { runEvents, toPublicRun, type RunEvent } from "../agent/runs.js";
import { tokenMatches } from "../agent/runTokens.js";
import { AgentRun } from "../db/models/agentRun.js";
import { Answer } from "../db/models/answer.js";
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
// An "Ask the coach" run (Stage 6 chunk B) also needs ?token=: one of the secret tokens POST /ask
// handed out for it (agent/runTokens.ts). Missing or wrong → the same 404 as an unknown run.
// Report runs need no token: reports are public, like the games they're built from.
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
    let answer = null;
    try {
      run = await AgentRun.findById(id);
      // An ask run without one of its tokens is treated exactly like a missing run.
      if (run?.kind === "ask" && !tokenMatches(run.tokenHashes, req.query.token)) run = null;
      // A finished run's snapshot carries its report (or answer), if it's still the kept one.
      if (run?.status === "done" && run.reportId) {
        const doc = await Report.findById(run.reportId);
        report = doc ? await publicReportOf(doc) : null;
      }
      if (run?.status === "done" && run.answerId) {
        const doc = await Answer.findById(run.answerId);
        answer = doc ? publicAnswerOf(doc) : null;
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
    const snapshot = toPublicRun(run, report, answer);
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
