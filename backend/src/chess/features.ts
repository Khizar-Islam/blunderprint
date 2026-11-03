import { Chess, type Move } from "chess.js";
import type { Classification, Color } from "../db/models/game.js";
import { sanMovesFromText } from "../importers/normalize.js";
import { moverOfPly, START_EVAL, winPercentFor, type Eval, type Judgement } from "./classify.js";
import { board64, normalizedFenOf } from "./fen.js";
import { divide, isEndgame, phaseOfPly, type Board64, type Division, type Phase } from "./phase.js";

// Feature extraction (CLAUDE.md 8.3): one analysed game in, the facts the dashboard and the
// coach aggregate out. Only the imported player's moves count: the opponent's mistakes are
// not what we coach.
//
// Bump FEATURES_VERSION whenever the output changes: the extract job re-extracts every game
// whose stored version differs, so old games pick up the new rules by themselves.
export const FEATURES_VERSION = 1;

export type PieceType = "p" | "n" | "b" | "r" | "q";
export type ClockBucket = "over50" | "from25to50" | "from10to25" | "under10";

export interface MistakeFeature {
  ply: number; // 1-based: the move that was the mistake
  kind: Judgement;
  phase: Phase;
  san: string; // the move played
  best?: string; // the engine's better move (UCI), when known
  winDrop: number; // how many points of win% (0–100) the move cost the player
  clockLeft?: number; // seconds left after the move
  timeTrouble?: boolean; // under 10% of the starting time
  square: string; // the move's destination square ("g1" for O-O by White)
  pieceLost?: PieceType; // the player's most valuable piece lost to it (see lostPiece)
  fen: string; // normalized FEN of the position BEFORE the move: where the better move applies
}

// Denominators for "errors per 100 of your moves": how many moves the player made in each
// phase and with how much of the clock left. Without them, "per game" would make the endgame
// look safe just because many games never reach one.
export interface MoveCounts {
  opening: number;
  middlegame: number;
  endgame: number;
  clock?: Record<ClockBucket, number>; // only for games with clocks and a real time control
}

export interface GameFeatures {
  version: number;
  division: Division;
  mistakes: MistakeFeature[];
  moveCounts: MoveCounts;
}

// What a stored replay-failure looks like, so the game isn't retried on every run.
export interface FeatureError {
  version: number;
  error: "replay_failed";
}

export interface FeatureInput {
  pgn: string;
  plies: number;
  color: Color;
  timeControl?: string | null;
  clocks?: number[] | null; // seconds left after each ply
  evals: Eval[]; // evals[i] = after ply i + 1, White's view
  classifications: Classification[];
  best?: (string | null)[] | null; // best[i] = the engine's best move before ply i + 1
}

export interface ExtractOptions {
  // Called between plies. The extract job passes a function that gives the event loop a
  // turn once ~50 ms have passed: replaying a game costs ~15 ms on my laptop and an estimated
  // ~250 ms on Render's CPU, too long to block /api/health and SSE in one go.
  maybeYield?: () => Promise<void> | void;
}

const PIECE_VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const JUDGEMENTS = new Set<Classification>(["inaccuracy", "mistake", "blunder"]);

// "180+2" → 180, "600" → 600. Daily games ("1/86400") and unknown ones → undefined: a clock
// counted in days has no time trouble worth showing.
export function initialSeconds(timeControl: string | null | undefined): number | undefined {
  if (!timeControl || timeControl.includes("/")) return undefined;
  const initial = Number(timeControl.split("+")[0]);
  return Number.isFinite(initial) && initial > 0 ? initial : undefined;
}

// Share of the starting clock left → bucket. With an increment the clock can be above 100%.
export function clockBucket(secondsLeft: number, initial: number): ClockBucket {
  const share = secondsLeft / initial;
  if (share > 0.5) return "over50";
  if (share > 0.25) return "from25to50";
  if (share >= 0.1) return "from10to25";
  return "under10";
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function extractFeatures(
  input: FeatureInput,
  { maybeYield }: ExtractOptions = {},
): Promise<GameFeatures | FeatureError> {
  const { plies, color, evals, classifications } = input;
  const failed: FeatureError = { version: FEATURES_VERSION, error: "replay_failed" };
  const sans = sanMovesFromText(input.pgn);
  if (!sans || sans.length !== plies || evals.length !== plies || classifications.length !== plies) return failed;

  // 1. Replay once, keeping what later steps need per ply: the move, the FEN before it (only
  //    for the player's judged moves, as fen() + the en-passant check isn't free), and the
  //    boards for the Divider (only until the endgame starts: after that it can't change).
  const chess = new Chess();
  const moves: Move[] = [];
  const fenBefore = new Map<number, string>();
  const boards: Board64[] = [board64(chess)];
  let endgameSeen = false;
  for (let i = 0; i < plies; i++) {
    const ply = i + 1;
    if (moverOfPly(ply) === color && JUDGEMENTS.has(classifications[i]!)) fenBefore.set(ply, normalizedFenOf(chess));
    // Only chess.move() is caught: an illegal move is the one failure that belongs to the game
    // itself (the browser engine would have reported it too). Anything else, above all an
    // abort thrown by maybeYield (shutdown, lost lease), must propagate: stored as
    // "replay_failed", it would mark a perfectly good game as broken.
    let move: Move;
    try {
      move = chess.move(sans[i]!);
    } catch {
      return failed;
    }
    moves.push(move);
    if (!endgameSeen) {
      const b = board64(chess);
      boards.push(b);
      endgameSeen = isEndgame(b);
    }
    await maybeYield?.();
  }
  // Boards stop at the first endgame position; Divider's answer only depends on the boards up
  // to there (the middlegame is found before it, or never).
  const division = divide(boards);

  // 2. The player's material balance after each ply (player minus opponent, in pawns), for
  //    "piece lost". balance[k] = after k plies.
  const balance = [0];
  moves.forEach((m, i) => {
    const sign = moverOfPly(i + 1) === color ? 1 : -1;
    let gain = m.captured ? PIECE_VALUE[m.captured as PieceType] : 0;
    if (m.promotion) gain += PIECE_VALUE[m.promotion as PieceType] - 1;
    balance.push(balance[i]! + sign * gain);
  });

  // 3. Walk the player's moves.
  const initial = initialSeconds(input.timeControl);
  const clocks = input.clocks && input.clocks.length === plies && initial ? input.clocks : undefined;
  const moveCounts: MoveCounts = { opening: 0, middlegame: 0, endgame: 0 };
  if (clocks) moveCounts.clock = { over50: 0, from25to50: 0, from10to25: 0, under10: 0 };
  const mistakes: MistakeFeature[] = [];

  for (let i = 0; i < plies; i++) {
    const ply = i + 1;
    if (moverOfPly(ply) !== color) continue;
    const phase = phaseOfPly(division, ply);
    moveCounts[phase]++;
    const clockLeft = clocks?.[i];
    if (clockLeft !== undefined && initial) moveCounts.clock![clockBucket(clockLeft, initial)]++;

    const kind = classifications[i]!;
    if (!JUDGEMENTS.has(kind)) continue;
    const move = moves[i]!;
    const prev = i === 0 ? START_EVAL : evals[i - 1]!;
    const winDrop = round1(winPercentFor(prev, color, ply - 1) - winPercentFor(evals[i]!, color, ply));
    const best = input.best?.[i];
    const pieceLost = lostPiece(moves, balance, ply, color);
    mistakes.push({
      ply,
      kind: kind as Judgement,
      phase,
      san: move.san,
      ...(best ? { best } : {}),
      winDrop,
      ...(clockLeft !== undefined && initial ? { clockLeft, timeTrouble: clockLeft < initial * 0.1 } : {}),
      square: move.to,
      ...(pieceLost ? { pieceLost } : {}),
      fen: fenBefore.get(ply)!,
    });
  }

  return { version: FEATURES_VERSION, division, mistakes, moveCounts };
}


// "Piece lost within 2 plies" (CLAUDE.md 8.3): compare the player's material balance before
// the mistake with the balance 2 plies after it (the opponent's reply and the player's next
// move, so a recapture counts). Down 2 or more pawns' worth → the most valuable piece the
// opponent took in that window. An even trade (Bxc6 bxc6) is not a loss.
export function lostPiece(moves: Move[], balance: number[], ply: number, color: Color): PieceType | undefined {
  const last = Math.min(ply + 2, moves.length);
  if (balance[ply - 1]! - balance[last]! < 2) return undefined;
  let worst: PieceType | undefined;
  for (let p = ply + 1; p <= last; p++) {
    const m = moves[p - 1]!;
    if (moverOfPly(p) === color || !m.captured) continue;
    const taken = m.captured as PieceType;
    if (!worst || PIECE_VALUE[taken] > PIECE_VALUE[worst]) worst = taken;
  }
  return worst;
}
