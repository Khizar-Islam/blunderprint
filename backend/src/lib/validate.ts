import type { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";

// Parse request input with zod; on failure send a fixed 400 message (never zod's own text,
// which can echo the input back).
export function parseOr400<T extends z.ZodType>(schema: T, value: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, message);
  return parsed.data;
}
