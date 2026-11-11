import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "./api";
import { isWakingError } from "./useWakingRequest";

test("retried while waking: no answer, or a 502/503/504 from Render's proxy (no code)", () => {
  assert.equal(isWakingError(new ApiError(0, "Can't reach the API")), true);
  assert.equal(isWakingError(new ApiError(502, "Bad gateway")), true);
  assert.equal(isWakingError(new ApiError(503, "Unavailable")), true);
});

test("not retried: a 4xx, or a 5xx with one of our codes (Stage 6 storage_full / busy)", () => {
  assert.equal(isWakingError(new ApiError(404, "Player not found")), false);
  assert.equal(isWakingError(new ApiError(429, "Too many", "limit_imports")), false);
  assert.equal(isWakingError(new ApiError(503, "Full", "storage_full")), false);
  assert.equal(isWakingError(new ApiError(503, "Busy", "busy")), false);
  assert.equal(isWakingError(new Error("x")), false);
});
