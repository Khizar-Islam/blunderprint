// Takes the landing page's demo snapshot: the demo player's Blunderprint ribbons, three
// evidence moves from their coach report, and the one move the landing's dive follows (its
// game's moves and the coach's own sentence about it), written to src/data/demo.json (committed).
//
// Run by hand (cmd, from web/), after the demo player's data is final:
//   npm run snapshot:demo
//   npm run snapshot:demo -- lichess:DrNykterstein https://blunderprint-api.onrender.com
//
// Why a committed file and not a live fetch: the hero must never wait on a sleeping Render
// API, and fetching at build time would make every Vercel build depend on Render waking up.
//
// It refuses to write a snapshot that could go wrong later: the player must be a FROZEN demo
// player (so the dashboard behind "Open this Blunderprint" shows the same games), every game
// analysed, the summary final and the coach report current.

import { writeFile } from "node:fs/promises";
import { Chess } from "chess.js";

const [key = "lichess:DrNykterstein", base = process.env.SNAPSHOT_API_URL ?? "https://blunderprint-api.onrender.com"] =
  process.argv.slice(2);
const [platform, username] = key.split(":");
const PLY_CAP = 120; // components/patterns/geometry.ts PLY_CAP: a note must point at a drawn tick
const OUT = new URL("../src/data/demo.json", import.meta.url);

const fail = (message) => {
  console.error(`snapshot-demo: ${message}`);
  process.exit(1);
};
if (!platform || !username) fail('the player must look like "lichess:DrNykterstein"');

async function get(path) {
  const url = `${base.replace(/\/+$/, "")}/api/players/${platform}/${encodeURIComponent(username)}${path}`;
  // A sleeping Render instance can take about a minute to answer the first request.
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) fail(`GET ${path || "/"} answered ${res.status}`);
  return res.json();
}

const { player } = await get("");
const { summary, extracting } = await get("/summary");
const info = await get("/report");

if (!player) fail("no such player");
if (player.demo !== true) fail("not a demo player: set DEMO_PLAYERS first, so the data is frozen");
if (extracting) fail("the summary is still being rebuilt");
if (summary.totals.analysed !== summary.totals.games) fail(`${summary.totals.games - summary.totals.analysed} games are not analysed yet`);
if (!info.report || info.report.patterns.length === 0) fail("no coach report with patterns");
if (info.stale) fail(`the coach report is stale (${info.staleReason})`);

const ribbonIds = new Set(summary.ribbons.map((r) => r.gameId));
const notes = info.report.patterns.slice(0, 3).map((p) => {
  const e = p.evidence.find((x) => x.ply <= PLY_CAP && ribbonIds.has(x.gameId));
  if (!e) fail(`pattern "${p.title}" has no evidence move inside the drawn print`);
  const evidence = { ...e };
  delete evidence.ribbon; // already in `ribbons`
  return { title: p.title, stat: p.stat, evidence };
});

// ---- The dive: one of the notes' moves, followed from the print down to the coach's sentence ----
// The costliest of the three that can be shown in full: both moves known as squares (the board's
// arrows) and a sentence of the report's explanation that names the move. The sentence is the
// model's own, word for word (already checked by the verifier); nothing here is written by hand.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const candidates = notes
  .map((n, index) => {
    const e = n.evidence;
    const pattern = info.report.patterns[index];
    const sentence = pattern.explanation.split(/(?<=[.!?])\s+/).find((s) => new RegExp(`(^|[^A-Za-z0-9])${escape(e.played)}([^A-Za-z0-9+#=]|$)`).test(s));
    return { index, e, sentence };
  })
  .filter((c) => c.sentence && c.e.playedUci && c.e.betterUci && c.e.betterMove)
  .sort((a, b) => b.e.winPctLost - a.e.winPctLost);
if (candidates.length === 0) fail("no note's move is named in its pattern's explanation with both moves known: nothing for the dive");
const chosen = candidates[0];
// The move's own figure inside that sentence ("49.4 win-chance points"), to underline; null when
// the sentence doesn't hold it.
const number = String(chosen.e.winPctLost);
const at = chosen.sentence.search(new RegExp(`(^|[^0-9.])${escape(number)}(?![0-9])`));
let figure = null;
if (at >= 0) {
  const from = chosen.sentence.indexOf(number, at);
  const unit = " win-chance points";
  figure = chosen.sentence.startsWith(unit, from + number.length) ? number + unit : number;
}
// The game's moves, for the strip's labels: its PGN, replayed here (never in the browser).
const gameRes = await fetch(`${base.replace(/\/+$/, "")}/api/games/${chosen.e.gameId}`, { signal: AbortSignal.timeout(120_000) });
if (!gameRes.ok) fail(`GET /api/games/${chosen.e.gameId} answered ${gameRes.status}`);
const gameBody = await gameRes.json();
const pgn = (gameBody.game ?? gameBody).pgn;
if (typeof pgn !== "string") fail("the dive's game came without a PGN");
const chess = new Chess();
chess.loadPgn(pgn);
const sans = chess.history();
const ribbon = summary.ribbons.find((r) => r.gameId === chosen.e.gameId);
if (sans.length !== ribbon.classes.length) fail(`the dive's game has ${sans.length} moves but ${ribbon.classes.length} classifications`);
if (sans[chosen.e.ply - 1].replace(/[+#]$/, "") !== chosen.e.played.replace(/[+#]$/, "")) fail(`the dive's move is ${chosen.e.played} but the game's move ${chosen.e.ply} is ${sans[chosen.e.ply - 1]}`);
const dive = { note: chosen.index, sentence: chosen.sentence, figure, sans };

const snapshot = {
  platform: player.platform,
  username: player.username,
  takenAt: new Date().toISOString(),
  lastImportedAt: player.lastImportedAt,
  reportGeneratedAt: info.report.generatedAt,
  analysedGames: summary.totals.analysed,
  notes,
  dive,
  ribbons: summary.ribbons.map(({ gameId, playedAt, color, result, speed, classes }) => ({ gameId, playedAt, color, result, speed, classes })),
};

// One ribbon per line: readable diffs when the snapshot is retaken.
const { ribbons, ...head } = snapshot;
// The dive's moves on one line too.
const body = JSON.stringify(head, null, 2)
  .replace(/"sans": \[[^\]]*\]/, `"sans": ${JSON.stringify(sans)}`)
  .replace(/\n}$/, "");
const json = `${body},\n  "ribbons": [\n${ribbons.map((r) => `    ${JSON.stringify(r)}`).join(",\n")}\n  ]\n}\n`;
JSON.parse(json); // still valid JSON
await writeFile(OUT, json);
console.log(
  `snapshot-demo: ${player.platform}:${player.username}, ${ribbons.length} games, ${notes.length} notes, the dive on ${chosen.e.played} (game ${chosen.e.gameId}), report of ${info.report.generatedAt} → src/data/demo.json (${(json.length / 1024).toFixed(1)} KB)`,
);
