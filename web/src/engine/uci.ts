// Parsing Stockfish's UCI output. UCI ("Universal Chess Interface") is the plain-text protocol
// every chess engine speaks: we send lines like "position startpos moves e2e4" and
// "go nodes 100000"; the engine answers with "info ..." lines while it searches and one
// "bestmove ..." line when it's done. Pure functions, so they're unit-tested without a worker.

// One evaluation from White's point of view, the shape the API stores (exactly one of cp/mate).
// mate > 0: White mates in N; mate < 0: Black mates in N; mate 0: the side to move is mated.
export type WhiteEval = { cp: number } | { mate: number };

// A score as the engine reports it: from the point of view of the side to move.
export type EngineScore = { cp: number } | { mate: number };

export interface InfoLine {
  depth?: number;
  nodes?: number;
  score?: EngineScore;
  // "lowerbound"/"upperbound": the search failed high/low and this score is only a bound,
  // not a real evaluation. Lichess's client ignores those; so do we, unless nothing else came.
  bound: boolean;
  pv?: string[];
}

// "info depth 12 seldepth 18 multipv 1 score cp -34 nodes 98123 nps ... pv e7e5 g1f3"
// Returns null for lines that aren't search info (e.g. "info string NNUE evaluation ...").
export function parseInfo(line: string): InfoLine | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "info" || tokens[1] === "string") return null;
  const info: InfoLine = { bound: false };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "depth") info.depth = Number(tokens[++i]);
    else if (t === "nodes") info.nodes = Number(tokens[++i]);
    else if (t === "score") {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      if (!Number.isInteger(value)) return null;
      if (kind === "cp") info.score = { cp: value };
      else if (kind === "mate") info.score = { mate: value };
      else return null;
      if (tokens[i + 1] === "lowerbound" || tokens[i + 1] === "upperbound") {
        info.bound = true;
        i++;
      }
    } else if (t === "pv") {
      info.pv = tokens.slice(i + 1);
      break; // pv is always last
    }
  }
  return info;
}

// "bestmove e2e4 ponder e7e5" → "e2e4". "bestmove (none)" (checkmate or stalemate: there is
// no move) → null. Not a bestmove line → undefined.
export function parseBestMove(line: string): string | null | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "bestmove") return undefined;
  const move = tokens[1];
  if (!move || move === "(none)" || move === "0000") return null;
  return move;
}

// The engine's score is from the side to move's view; the API wants White's view.
// mate 0 ("the side to move is mated") means the same thing from either side, so it stays 0
// (and -0 is avoided: JSON would send it as 0 anyway, but tests compare with deepEqual).
export function toWhitePov(score: EngineScore, whiteToMove: boolean): WhiteEval {
  if ("mate" in score) return { mate: whiteToMove || score.mate === 0 ? score.mate : -score.mate };
  return { cp: whiteToMove || score.cp === 0 ? score.cp : -score.cp };
}

// Collects the info lines of one search and keeps the score to use: the last exact score,
// or the last bound if the search never produced an exact one (very small node budgets).
export class SearchCollector {
  private exact?: EngineScore;
  private boundScore?: EngineScore;

  push(line: string): void {
    const info = parseInfo(line);
    if (!info?.score) return;
    if (info.bound) this.boundScore = info.score;
    else this.exact = info.score;
  }

  get score(): EngineScore | undefined {
    return this.exact ?? this.boundScore;
  }
}
