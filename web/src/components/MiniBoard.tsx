// A small view-only board: 64 plain squares, the pieces as images (our own copy of the piece
// drawings in public/pieces/, scripts/make-pieces.mjs) and two arrows: the move played in rust,
// the better move in teal. No board library behind it: the pages that use it (the dashboard's
// readout) never drag a piece, and react-chessboard would add ~50 KB of script for nothing.
//
// `fen` null: an empty board. `mark`: a square tinted brick (an error landed there, but its
// position isn't known here).

const RUST = "#D9772B"; // hex, not CSS variables: these are SVG attributes
const TEAL = "#3E7C74";

export type Side = "white" | "black";

// A square's column and row (0–7 from the top left) as `side` sees the board.
export function boardXY(square: string, side: Side): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return side === "white" ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank };
}

// The pieces of a FEN's first field, placed as `side` sees them. name: "wK", "bN" … (the file
// names in public/pieces/).
export function piecesOf(fen: string, side: Side): { name: string; x: number; y: number }[] {
  const out: { name: string; x: number; y: number }[] = [];
  (fen.split(" ")[0] ?? "").split("/").forEach((line, r) => {
    let file = 0;
    for (const ch of line) {
      if (ch >= "1" && ch <= "8") file += Number(ch);
      else {
        const upper = ch.toUpperCase();
        if ("KQRBNP".includes(upper) && file < 8 && r < 8) {
          out.push({ name: (ch === upper ? "w" : "b") + upper, ...(side === "white" ? { x: file, y: r } : { x: 7 - file, y: 7 - r }) });
        }
        file++;
      }
    }
  });
  return out;
}

export const PIECE_NAMES = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"] as const;
export const pieceSrc = (name: string) => `/pieces/${name}.svg`;

// An arrow from a UCI move's start square to its end square, in board units (0–8).
export function arrowOf(uci: string, side: Side) {
  const a = boardXY(uci.slice(0, 2), side);
  const b = boardXY(uci.slice(2, 4), side);
  const A = { x: a.x + 0.5, y: a.y + 0.5 };
  const B = { x: b.x + 0.5, y: b.y + 0.5 };
  const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  const ux = (B.x - A.x) / len;
  const uy = (B.y - A.y) / len;
  const tip = { x: B.x - ux * 0.16, y: B.y - uy * 0.16 };
  const base = { x: tip.x - ux * 0.46, y: tip.y - uy * 0.46 };
  const s = { x: -uy * 0.27, y: ux * 0.27 };
  return { A, base, head: `${tip.x},${tip.y} ${base.x + s.x},${base.y + s.y} ${base.x - s.x},${base.y - s.y}` };
}

const UCI = /^[a-h][1-8][a-h][1-8]/;

function Arrow({ uci, side, color }: { uci: string | null | undefined; side: Side; color: string }) {
  if (!uci || !UCI.test(uci)) return null;
  const { A, base, head } = arrowOf(uci, side);
  return (
    <g opacity={0.9}>
      <line x1={A.x} y1={A.y} x2={base.x} y2={base.y} stroke={color} strokeWidth={0.2} strokeLinecap="round" />
      <polygon points={head} fill={color} />
    </g>
  );
}

export function MiniBoard({
  fen,
  side,
  playedUci,
  betterUci,
  mark,
  label,
}: {
  fen: string | null;
  side: Side;
  playedUci?: string | null;
  betterUci?: string | null;
  mark?: string | null;
  label: string;
}) {
  const pieces = fen ? piecesOf(fen, side) : [];
  const marked = mark ? boardXY(mark, side) : null;
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-sm" role="img" aria-label={label}>
      <div className="grid h-full w-full grid-cols-8 grid-rows-8">
        {Array.from({ length: 64 }, (_, i) => (
          <div key={i} className={(Math.floor(i / 8) + i) % 2 === 0 ? "bg-square-light" : "bg-square-dark"} />
        ))}
      </div>
      {marked && <div className="absolute h-[12.5%] w-[12.5%] bg-blunder/80" style={{ left: `${marked.x * 12.5}%`, top: `${marked.y * 12.5}%` }} />}
      {pieces.map((p) => (
        // Plain <img>: 12 tiny cached files; next/image would only add a wrapper and a loader.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${p.x}${p.y}`}
          src={pieceSrc(p.name)}
          alt=""
          draggable={false}
          className="absolute h-[12.5%] w-[12.5%] select-none"
          style={{ left: `${p.x * 12.5}%`, top: `${p.y * 12.5}%` }}
        />
      ))}
      <svg viewBox="0 0 8 8" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        <Arrow uci={playedUci} side={side} color={RUST} />
        <Arrow uci={betterUci} side={side} color={TEAL} />
      </svg>
    </div>
  );
}
