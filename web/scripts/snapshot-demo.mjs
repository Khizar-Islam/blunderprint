// Takes the landing page's demo snapshot: the demo player's Blunderprint ribbons and three
// evidence moves from their coach report, written to src/data/demo.json (committed).
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

const snapshot = {
  platform: player.platform,
  username: player.username,
  takenAt: new Date().toISOString(),
  lastImportedAt: player.lastImportedAt,
  reportGeneratedAt: info.report.generatedAt,
  analysedGames: summary.totals.analysed,
  notes,
  ribbons: summary.ribbons.map(({ gameId, playedAt, color, result, speed, classes }) => ({ gameId, playedAt, color, result, speed, classes })),
};

// One ribbon per line: readable diffs when the snapshot is retaken.
const { ribbons, ...head } = snapshot;
const body = JSON.stringify(head, null, 2).replace(/\n}$/, "");
const json = `${body},\n  "ribbons": [\n${ribbons.map((r) => `    ${JSON.stringify(r)}`).join(",\n")}\n  ]\n}\n`;
JSON.parse(json); // still valid JSON
await writeFile(OUT, json);
console.log(
  `snapshot-demo: ${player.platform}:${player.username}, ${ribbons.length} games, ${notes.length} notes, report of ${info.report.generatedAt} → src/data/demo.json (${(json.length / 1024).toFixed(1)} KB)`,
);
