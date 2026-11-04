import { z } from "zod";

// The coach's final answer (CLAUDE.md §10) in two forms:
// - REPORT_JSON_SCHEMA goes to the model as response_format, so the API constrains its output.
//   Google enforces minItems/maxItems but ignores minLength/maxLength (structured output docs),
//   so lengths are only checked here.
// - reportSchema (zod) checks what actually came back. Text that runs long is cut, not
//   rejected: a wordy explanation isn't worth a failed run.

const clip = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((s) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s));

export const evidenceSchema = z.object({
  gameId: z.string(),
  ply: z.number().int().positive(),
});

// A pattern cites a weakness candidate (get_weakness_candidates) by id. The model writes no
// statistic and no label: the verifier copies the value, baseline, direction and label from
// the candidate, so the number shown is always the one code computed.
export const patternSchema = z.object({
  candidateId: z.string().trim().min(1).max(200),
  explanation: clip(900),
  // The find_example_mistakes step the evidence was taken from: its filters must be the
  // candidate's exampleFilter (or narrower), and every item must be one of its examples.
  evidenceStep: z.number().int().positive(),
  evidence: z.array(evidenceSchema).min(1).max(6),
  drill: clip(500),
});

export const reportSchema = z.object({
  notEnoughData: z
    .string()
    .trim()
    .max(600)
    .optional()
    .transform((s) => (s ? s : undefined)),
  patterns: z.array(patternSchema).max(5),
});

export type DraftPattern = z.infer<typeof patternSchema>;
export type DraftReport = z.infer<typeof reportSchema>;

export const REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    notEnoughData: {
      type: "string",
      description: "Only when there aren't 3 distinct, well-backed candidates: say why in one or two sentences. Otherwise an empty string.",
    },
    patterns: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string", description: "The id of one get_weakness_candidates candidate, copied exactly." },
          explanation: { type: "string", description: "2-4 sentences to the player ('you'): what happens, when, and why it costs games." },
          evidenceStep: { type: "integer", description: "The `step` of the find_example_mistakes result (called with this candidate's exampleFilter) the evidence comes from." },
          evidence: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                gameId: { type: "string" },
                ply: { type: "integer" },
              },
              required: ["gameId", "ply"],
            },
          },
          drill: { type: "string", description: "One concrete exercise for this pattern, built on what the evidence positions share." },
        },
        required: ["candidateId", "explanation", "evidenceStep", "evidence", "drill"],
      },
    },
  },
  required: ["patterns"],
} as const;

// The model's final text → a draft report, or why it isn't one. Tolerates a ```json fence
// around the JSON (some models add one even under structured output).
export function parseReport(text: string): { ok: true; report: DraftReport } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) return { ok: false, error: "the answer was empty" };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "the answer wasn't valid JSON" };
  }
  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, error: `the JSON didn't match the report schema (${issue.path.join(".") || "root"}: ${issue.message})` };
  }
  return { ok: true, report: parsed.data };
}
