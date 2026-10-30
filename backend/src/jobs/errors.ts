// Thrown by job handlers to tell the worker what to do with a failure.

// Try again later (network error, 429, upstream 5xx). retryAfterMs overrides the normal backoff.
export class RetryableError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

// Retrying can't help (the user doesn't exist, bad payload). The job fails immediately.
// The message is shown to the user, so keep it plain and free of internals.
export class FatalError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "FatalError";
  }
}
