import type { ErrorRequestHandler, RequestHandler } from "express";
import { logger } from "../lib/logger.js";

// Throw this (or any error with a numeric statusCode) to send a 4xx with a safe message.
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// express.json() errors carry a `type`. Map them to fixed messages instead of echoing the parser's text.
const BODY_PARSER_ERRORS: Record<string, { status: number; message: string }> = {
  "entity.parse.failed": { status: 400, message: "Request body is not valid JSON" },
  "entity.too.large": { status: 413, message: "Request body is too large" },
  "encoding.unsupported": { status: 415, message: "Unsupported content encoding" },
  "charset.unsupported": { status: 415, message: "Unsupported charset" },
  "request.aborted": { status: 400, message: "Request was aborted" },
};

// Unknown /api routes get JSON, not Express's default HTML page.
export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // The response already started (e.g. an SSE stream): let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = res.locals.requestId as string | undefined;

  const bodyError = typeof err?.type === "string" ? BODY_PARSER_ERRORS[err.type] : undefined;
  if (bodyError) {
    res.status(bodyError.status).json({ error: bodyError.message });
    return;
  }

  // Only our own statusCode sets a 4xx. err.status is ignored on purpose: SDK errors
  // (Gemini, Mongo drivers) carry their own status, which is about *their* request, not this one.
  const statusCode = err?.statusCode;
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    res.status(statusCode).json({ error: String(err.message) });
    return;
  }

  // Everything else is a 5xx: log the real error, send a fixed message.
  logger.error("Unhandled error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({ error: "Internal server error", requestId });
};
