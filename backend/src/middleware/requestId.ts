import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "../lib/logger.js";

// Gives every request an ID (echoed in the X-Request-Id header) and logs one line when it finishes.
export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  const started = performance.now();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  res.on("finish", () => {
    logger.info("request", {
      requestId: id,
      method: req.method,
      // Full path without the query string (req.path alone is relative to the router it ran in).
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      ms: Math.round(performance.now() - started),
    });
  });
  next();
};
