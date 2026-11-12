import type { AskSuggestion, CoachAnswer, SlotKind } from "./api";

// "Ask the coach" (Stage 6 chunk C): the rules behind the question box and the answer, kept
// free of React so they're tested (ask.test.ts). The backend has the final word on every one of
// them (routes/ask.ts, agent/ask.ts); these only keep the page honest before a request is sent.

// ---- The question --------------------------------------------------------------------------

export const MIN_QUESTION_CHARS = 3;
export const MAX_QUESTION_CHARS = 300;
// From here on the counter is announced to screen readers ("40 characters left").
export const COUNTER_ANNOUNCE_FROM = 260;

// The same cleaning as the API (agent/ask.ts cleanQuestion): Unicode NFKC, runs of spaces and
// line breaks become one space, trimmed. The limits apply to this cleaned text.
export function cleanQuestion(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export interface Counter {
  length: number;
  text: string; // "42 / 300"
  over: boolean; // too long to send
  near: boolean; // close enough to the limit to announce
  announce: string | null; // the screen-reader text, near the limit only
}

export function counter(text: string): Counter {
  const length = cleanQuestion(text).length;
  const left = MAX_QUESTION_CHARS - length;
  const near = length >= COUNTER_ANNOUNCE_FROM;
  return {
    length,
    text: `${length} / ${MAX_QUESTION_CHARS}`,
    over: left < 0,
    near,
    announce: !near ? null : left >= 0 ? `${left} character${left === 1 ? "" : "s"} left` : `${-left} character${left === -1 ? "" : "s"} too many`,
  };
}

// Two questions are the same question for the answer cache when they match after cleaning,
// lower-casing and dropping trailing ?.! (the API's questionKey hashes this same text).
export const questionKeyText = (text: string) => cleanQuestion(text).toLowerCase().replace(/[?.!\s]+$/, "");

export function canSend(text: string): boolean {
  const n = cleanQuestion(text).length;
  return n >= MIN_QUESTION_CHARS && n <= MAX_QUESTION_CHARS;
}

// ---- The answer ----------------------------------------------------------------------------

export type AnswerPart = { type: "text"; text: string } | { type: "figure"; name: string; text: string; kind: SlotKind };

// "You make {{a}} in the endgame." → text, figure, text. Same placeholder syntax as the API's
// fillSentence (agent/slots.ts). A placeholder with no slot renders nothing (the verifier never
// lets one through; this is only a guard). Empty text parts are left out.
export function fillTemplate(sentence: string, slots: CoachAnswer["slots"]): AnswerPart[] {
  const parts: AnswerPart[] = [];
  const re = /\{\{\s*([^{}]*?)\s*\}\}/g;
  let last = 0;
  for (let m = re.exec(sentence); m; m = re.exec(sentence)) {
    if (m.index > last) parts.push({ type: "text", text: sentence.slice(last, m.index) });
    const name = m[1]!;
    const slot = Object.prototype.hasOwnProperty.call(slots, name) ? slots[name] : undefined;
    if (slot) parts.push({ type: "figure", name, text: slot.text, kind: slot.kind });
    last = m.index + m[0].length;
  }
  if (last < sentence.length) parts.push({ type: "text", text: sentence.slice(last) });
  return parts;
}

// The sentence as plain text (the screen-reader / copy form).
export const sentenceText = (parts: AnswerPart[]) => parts.map((p) => p.text).join("");

// ---- Refusals and failures -----------------------------------------------------------------

export type AskAction =
  | "retry" // Try again (now)
  | "retry-later" // Try again, enabled after `waitMs` (busy: Retry-After)
  | "none"; // nothing to click: the message says when (limits, budget) or why (AI off)

export interface AskErrorView {
  title: string;
  message: string;
  action: AskAction;
  waitMs?: number;
}

const BUSY_WAIT_MS = 60_000; // the API's busy Retry-After, if the header couldn't be read

// What each friendly code (backend agent/friendly.ts) shows under a question. The message is the
// API's own fixed text; only the title and the action are decided here.
export function askErrorView(error: { code?: string; message: string; retryAfterMs?: number }): AskErrorView {
  const { message } = error;
  switch (error.code) {
    case "limit_questions":
      return { title: "That's the limit for now", message, action: "none" };
    case "busy":
      return { title: "The coach is busy", message, action: "retry-later", waitMs: error.retryAfterMs ?? BUSY_WAIT_MS };
    case "ai_disabled":
      return { title: "New questions are paused", message, action: "none" };
    case "ai_budget_exhausted":
      return { title: "The coach is resting", message, action: "none" };
    case "not_enough_games":
      return { title: "Not enough analysed games yet", message, action: "none" };
    case "player_not_found":
      return { title: "No games yet", message, action: "none" };
    default:
      // A failed run (ai_busy, ai_unavailable, coach_timeout, coach_too_long, coach_no_answer,
      // coach_interrupted, internal), a lost stream, a bad request, and anything new.
      return { title: "The coach couldn't answer", message, action: "retry" };
  }
}

// ---- The chips -----------------------------------------------------------------------------

// A chip can be clicked when no question is on its way, and either its answer is cached (served
// even with the AI off) or the AI is on. The API decides the rest (budget, limits).
export function chipEnabled(s: AskSuggestion, { aiEnabled, busy }: { aiEnabled: boolean; busy: boolean }): boolean {
  return !busy && (s.answered || aiEnabled);
}

// The free-text box needs the AI (a typed question is almost never cached).
export const boxEnabled = ({ aiEnabled, busy }: { aiEnabled: boolean; busy: boolean }) => aiEnabled && !busy;
