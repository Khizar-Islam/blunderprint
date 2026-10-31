import { Router } from "express";
import { z } from "zod";
import { Job } from "../db/models/job.js";
import { jobEvents, toPublicJob, type JobEvent } from "../jobs/events.js";
import { openSse, type SseStream } from "../lib/sse.js";
import { parseOr400 } from "../lib/validate.js";
import { HttpError } from "../middleware/errorHandler.js";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i);
const isFinished = (status: string) => status === "done" || status === "failed";

export function jobsRouter({ heartbeatMs }: { heartbeatMs?: number } = {}): Router {
  const router = Router();

  // SSE: job progress. Events: snapshot (current state, always first), then progress,
  // retrying, done, failed. Every event's data is the whole public job and its id is the rev,
  // so the client can always just render the latest message it got.
  router.get("/jobs/:id/stream", async (req, res) => {
    const id = parseOr400(objectId, req.params.id, "Invalid job id");

    // 1. Subscribe before reading, buffering events until the snapshot is out. Reading first
    //    would lose any update that lands between the read and the subscribe.
    let stream: SseStream | null = null;
    let sentRev = -1;
    const buffered: JobEvent[] = [];
    const deliver = (event: JobEvent) => {
      // Older or repeated revs carry nothing new (the snapshot already covered them).
      if (!stream || event.job.rev <= sentRev) return;
      sentRev = event.job.rev;
      stream.send(event.type, event.job, event.job.rev);
      if (isFinished(event.job.status)) stream.close();
    };
    const unsubscribe = jobEvents.subscribe(id, (event) => (stream ? deliver(event) : buffered.push(event)));

    // 2. The snapshot from the DB. 404 is still a normal JSON response: the stream isn't open yet.
    let job;
    try {
      job = await Job.findById(id);
    } catch (err) {
      unsubscribe();
      throw err;
    }
    if (!job) {
      unsubscribe();
      throw new HttpError(404, "Job not found");
    }

    stream = openSse(res, { heartbeatMs });
    stream.onClose(unsubscribe);
    const snapshot = toPublicJob(job);
    sentRev = snapshot.rev;
    stream.send("snapshot", snapshot, snapshot.rev);
    if (isFinished(snapshot.status)) {
      stream.close();
      return;
    }

    // 3. Whatever arrived while we were reading, minus what the snapshot already includes.
    for (const event of buffered) deliver(event);
  });

  return router;
}
