import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { logger, withoutLogContext } from "../lib/logger.js";

// Gives every request an ID (echoed in the X-Request-Id header) and logs one line when it ends.
export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  const started = performance.now();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  let logged = false;
  const log = (aborted: boolean) => {
    if (logged) return;
    logged = true;
    // withoutLogContext: a job's "done" event ends its SSE stream from inside the job's log
    // context, and this line would then carry that job's id. A request line is about the request.
    withoutLogContext(() =>
      logger.info("request", {
        requestId: id,
        method: req.method,
        // Full path without the query string (req.path alone is relative to the router it ran in).
        // The query string is dropped on purpose: an ask run's secret token travels in it.
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        ...(aborted ? { aborted: true } : {}),
      }),
    );
  };
  // "finish": the whole response was handed to the network. "close" also fires when the
  // connection ends BEFORE that (the visitor closed the tab on an SSE stream, or gave up on a
  // slow request), which "finish" never reports: those get their line too, marked aborted.
  res.on("finish", () => log(false));
  res.on("close", () => log(!res.writableFinished));
  next();
};
