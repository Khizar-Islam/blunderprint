import { Chess } from "chess.js";
import type { CoachEvidence, CoachInfo, CoachStat, ErrorKind } from "./api";

// The coach's display rules, kept pure so they are tested (coach.test.ts): what the dashboard
// button says, how a statistic and an evidence position read, and what a failure offers.

// ---- The dashboard button -------------------------------------------------------------------

export type CoachButtonState =
  | { kind: "loading" }
  | { kind: "running"; runId: string }
  | {
      kind: "report";
      // Why the report is out of date, when it is.
      stale: null | { reason: "new_games"; newGames: number } | { reason: "new_version" };
      // A new report can't be started right now (the report itself is still there).
      note: null | "off" | "resting";
    }
  | { kind: "locked"; analysed: number; needed: number }
  | { kind: "off" }
  | { kind: "resting" }
  | { kind: "start" };

export function coachButtonState(info: CoachInfo | null): CoachButtonState {
  if (!info) return { kind: "loading" };
  if (info.activeRun) return { kind: "running", runId: info.activeRun.runId };
  const blocked = !info.ai.enabled ? "off" : !info.ai.canStart ? "resting" : null;
  if (info.report) {
    const stale = !info.stale
      ? null
      : info.staleReason === "new_version"
        ? ({ reason: "new_version" } as const)
        : ({ reason: "new_games", newGames: info.newGames } as const);
    return { kind: "report", stale, note: stale ? blocked : null };
  }
  if (!info.eligibility.ok) return { kind: "locked", analysed: info.eligibility.analysed, needed: info.eligibility.needed };
  if (blocked) return { kind: blocked };
  return { kind: "start" };
}

// ---- Time: the budget resets at midnight Pacific (backend agent/budget.ts) ------------------

const PACIFIC = "America/Los_Angeles";
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: PACIFIC, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit" });
const HOUR = 3_600_000;

// The same rule as the backend: the wall-clock guess, corrected by an hour on DST change days.
export function msUntilPacificMidnight(at: Date): number {
  const [h, m, s] = timeFormat.format(at).split(":").map(Number) as [number, number, number];
  const guess = at.getTime() + 24 * HOUR - ((h * 60 + m) * 60 + s) * 1000 - at.getMilliseconds();
  const today = dayFormat.format(at);
  for (const t of [guess - HOUR, guess, guess + HOUR]) {
    if (dayFormat.format(new Date(t)) !== today && dayFormat.format(new Date(t - 1)) === today) return t - at.getTime();
  }
  return guess - at.getTime();
}

export const hoursText = (ms: number) => {
  const h = Math.max(1, Math.round(ms / HOUR));
  return `~${h} h`;
};

// ---- The statistic: "7.9 vs your 3.1" --------------------------------------------------------

const NOUN: Record<CoachStat["measure"], string> = {
  per100Moves: "errors per 100 moves",
  inaccuracyPer100: "inaccuracies per 100 moves",
  mistakePer100: "mistakes per 100 moves",
  blunderPer100: "blunders per 100 moves",
  errorsPerGame: "errors per game",
  scorePct: "score",
};

export interface StatText {
  value: (n: number) => string;
  baseline: string; // "3.1"
  unit: string; // "blunders per 100 moves"
  gap: string; // "+155% more" / "35% lower"
  sample: string; // "15 games · 190 moves · 31 errors"
}

const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export function statText(stat: CoachStat): StatText {
  const pct = stat.unit === "percent";
  const fmt = (n: number) => (pct ? `${Math.round(n)}%` : one(n));
  return {
    value: fmt,
    baseline: fmt(stat.baseline),
    unit: NOUN[stat.measure],
    gap: stat.direction === "higherIsWorse" ? `${stat.gapPct}% more than usual` : `${stat.gapPct}% lower than usual`,
    sample: [
      plural(stat.games, "game"),
      stat.moves != null ? plural(stat.moves, "move") : null,
      stat.errors != null ? plural(stat.errors, "error") : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

// ---- One evidence position -------------------------------------------------------------------

export const ANNOTATION: Record<ErrorKind, string> = { inaccuracy: "?!", mistake: "?", blunder: "??" };

// "Move 18" + "Rad8??" + "blunder" + "better Qc4" + "−40 pts win chance". winPctLost is the drop
// in win chance in percentage POINTS (e.g. 85% → 45% is 40 points), so it must not read as "40%".
export function moveCaption(e: CoachEvidence) {
  return {
    move: `Move ${e.moveNumber}${e.color === "black" ? "…" : "."}`,
    played: `${e.played}${ANNOTATION[e.kind]}`,
    kind: e.kind,
    better: e.betterMove,
    cost: `−${Math.round(e.winPctLost)} pts win chance`,
  };
}

const CLOCK_TEXT: Record<string, string> = {
  over50: "over half the clock left",
  from25to50: "25–50% of the clock left",
  from10to25: "10–25% of the clock left",
  under10: "under 10% of the clock left",
};

const clock = (seconds: number) => {
  if (seconds < 60) return `${Math.round(seconds)} s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")} left`;
};

// The situation, from code: "bullet · middlegame · 0:50 left (over half the clock) · A05 King's
// Indian Attack". Missing facts are left out, never guessed.
export function factsLine(e: CoachEvidence): string[] {
  const f = e.facts;
  const parts: string[] = [];
  if (f.speed) parts.push(f.speed);
  if (f.phase) parts.push(f.phase);
  if (f.clockLeftSeconds != null) parts.push(f.clockBucket ? `${clock(f.clockLeftSeconds)} (${CLOCK_TEXT[f.clockBucket] ?? f.clockBucket})` : clock(f.clockLeftSeconds));
  else if (f.clockBucket) parts.push(CLOCK_TEXT[f.clockBucket] ?? f.clockBucket);
  if (f.opening) parts.push(f.opening.name ? `${f.opening.eco} ${f.opening.name}` : f.opening.eco);
  return parts;
}

// UCI "g1f3" → the two squares (react-chessboard arrows).
export function uciSquares(uci: string | null | undefined): { from: string; to: string } | null {
  if (!uci || !/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

// The position AFTER the played move, for the slide along the rust arrow. chess.js plays it,
// so castling, en passant and promotion come out right. null if it can't be played there.
export function fenAfterMove(fen: string, uci: string | null | undefined): string | null {
  const sq = uciSquares(uci);
  if (!sq) return null;
  try {
    const chess = new Chess(fen.split(" ").length === 4 ? `${fen} 0 1` : fen);
    chess.move({ from: sq.from, to: sq.to, promotion: uci!.length === 5 ? uci![4] : undefined });
    return chess.fen();
  } catch {
    return null;
  }
}

// ---- Failures: what each friendly code offers (backend agent/friendly.ts) --------------------

export type FailureAction = "retry" | "none" | "wait" | "dashboard" | "import" | "reload";

export function failureAction(code: string | undefined): FailureAction {
  switch (code) {
    case "ai_disabled":
      return "none";
    case "ai_budget_exhausted":
    case "limit_reports": // this visitor's reports for today (Stage 6)
      return "wait";
    case "not_enough_games":
      return "dashboard";
    case "player_not_found":
      return "import";
    case "run_not_found":
      return "reload";
    default:
      // ai_busy, ai_unavailable, coach_timeout, coach_too_long, coach_no_answer,
      // coach_interrupted, internal, and anything new: trying again is the honest offer.
      return "retry";
  }
}
