import type { ErrorRequestHandler, RequestHandler } from "express";
import { errorMessage, logger } from "../lib/logger.js";

// Throw this (or any error with a numeric statusCode) to send a 4xx with a safe message.
// `code` (optional) is a machine-readable reason the page can switch on, e.g. "not_enough_games".
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
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

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = res.locals.requestId as string | undefined;

  // The response already started (e.g. an SSE stream that failed midway): no status or body can
  // be sent any more, so the only honest signal left is to cut the connection (EventSource then
  // reconnects). Express's default handler does exactly that, but it also prints the error with
  // console.error: a raw multi-line stack with no request ID. So we log our one line and cut
  // the connection ourselves instead of calling next(err).
  if (res.headersSent) {
    logger.error("response_failed_after_headers", {
      requestId,
      path: req.originalUrl.split("?")[0],
      error: errorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    req.socket.destroy();
    return;
  }

  const bodyError = typeof err?.type === "string" ? BODY_PARSER_ERRORS[err.type] : undefined;
  if (bodyError) {
    res.status(bodyError.status).json({ error: bodyError.message });
    return;
  }

  // Only our own statusCode sets a 4xx. err.status is ignored on purpose: SDK errors
  // (Gemini, Mongo drivers) carry their own status, which is about *their* request, not this one.
  const statusCode = err?.statusCode;
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    res.status(statusCode).json({ error: String(err.message), ...(err instanceof HttpError && err.code ? { code: err.code } : {}) });
    return;
  }

  // Everything else is a 5xx: log the real error, send a fixed message.
  logger.error("unhandled_error", {
    requestId,
    error: errorMessage(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({ error: "Internal server error", requestId });
};
