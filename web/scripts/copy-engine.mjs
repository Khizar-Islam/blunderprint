// Copies the Stockfish engine from node_modules/stockfish into public/engine/, so Next serves
// it as plain static files (a Web Worker script and its .wasm must be real URLs, not bundled).
// Runs automatically before `npm run dev` and `npm run build` (predev / prebuild), on my
// machine and on Vercel. The files are gitignored: the exact version is pinned in package.json
// and package-lock.json, so there are no binaries in git.
//
// Which build: the lite single-threaded one (~1.9 MB). It needs no COOP/COEP headers; the
// multi-threaded builds need cross-origin isolation (CLAUDE.md section 17).
//
// Licence: Stockfish is GPL-3.0. Serving these files distributes them, so the licence text
// (Copying.txt) goes next to them, plus SOURCE.txt saying exactly where their source code is.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(webDir, "public", "engine");

const pkgJsonPath = require.resolve("stockfish/package.json");
const pkgDir = dirname(pkgJsonPath);
const { version } = JSON.parse(readFileSync(pkgJsonPath, "utf8"));

const FILES = [
  ["bin/stockfish-19-lite-single.js", "stockfish-19-lite-single.js"],
  ["bin/stockfish-19-lite-single.wasm", "stockfish-19-lite-single.wasm"],
  ["Copying.txt", "Copying.txt"],
];

mkdirSync(outDir, { recursive: true });
for (const [from, to] of FILES) {
  const src = join(pkgDir, from);
  // Fail the build loudly instead of shipping a site whose engine 404s.
  if (!existsSync(src)) {
    console.error(`copy-engine: ${src} is missing (stockfish ${version}). Did the package layout change?`);
    process.exit(1);
  }
  copyFileSync(src, join(outDir, to));
}

writeFileSync(
  join(outDir, "SOURCE.txt"),
  [
    `Stockfish.js ${version} (lite, single-threaded build), unmodified, from the npm package "stockfish".`,
    "Licence: GNU General Public License v3, see Copying.txt in this folder.",
    "",
    "Source code:",
    `  Stockfish.js (the WASM build and its glue code): https://github.com/nmrugg/stockfish.js/tree/v${version}`,
    "  Stockfish (the engine): https://github.com/official-stockfish/Stockfish",
    "",
    "Blunderprint talks to the engine only through UCI text messages to a Web Worker.",
    "Blunderprint's own source: https://github.com/Khizar-Islam/blunderprint",
    "",
  ].join("\n"),
);

console.log(`copy-engine: stockfish ${version} → public/engine/ (${FILES.length + 1} files)`);
