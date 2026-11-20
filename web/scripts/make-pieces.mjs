// By hand: node scripts/make-pieces.mjs   (from web/)
//
// Writes our own copy of the 12 chess piece drawings to public/pieces/<wK|bN|…>.svg, from the
// set react-chessboard ships (Colin M.L. Burnett's drawings; THIRD_PARTY_NOTICES.md).
//
// Why a copy: the small view-only boards (the dashboard's readout, the landing page) are plain
// squares with <img> pieces. Importing the pieces from react-chessboard would pull the whole
// drag-and-drop board (~50 KB of script) into pages that never drag anything. As files they
// cost no script at all, are cached by the browser, and the CSP's img-src 'self' covers them.
//
// Re-run only if react-chessboard's piece set changes (the files are committed).
import { mkdirSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPieces } from "react-chessboard";

mkdirSync("public/pieces", { recursive: true });
for (const [name, piece] of Object.entries(defaultPieces)) {
  const svg = renderToStaticMarkup(piece({}));
  if (!svg.startsWith("<svg")) throw new Error(`${name}: not an svg`);
  writeFileSync(`public/pieces/${name}.svg`, `${svg}\n`);
  console.log(name, svg.length);
}
