// One-off: classify the Lichess games imported before Stage 2. They have Lichess's evals but no
// classifications, accuracy or best moves, because Stage 1 didn't keep Lichess's judgements.
//
// Lichess's own judgements are the source of truth for its analysis (see ClassifyInput.judgments
// in src/chess/classify.ts), and they aren't stored, so this fetches them again with Lichess's
// "export games by IDs" endpoint: up to 300 ids per request, one request at a time.
//
// DRY RUN BY DEFAULT: fetches and computes everything, prints the counts, writes nothing.
//   npm run backfill:classifications              (dry run)
//   npm run backfill:classifications -- --apply   (writes)
//
// Safe to repeat: it only picks imported games that have no classifications yet, and each
// write re-checks that the game is still "imported". It never deletes anything.
import mongoose from "mongoose";
import { averageAccuracy, classifyGame, type Eval, type Judgement } from "../src/chess/classify.js";
import { loadEnv } from "../src/config/env.js";
import { Game } from "../src/db/models/game.js";
import { parseLichessAnalysis, type LichessGame } from "../src/importers/lichess.js";
import { createPoliteClient, userAgent } from "../src/importers/politeFetch.js";

const APPLY = process.argv.includes("--apply");
const IDS_PER_REQUEST = 300; // Lichess API: "300 IDs can be submitted."

interface Candidate {
  _id: mongoose.Types.ObjectId;
  sourceId: string;
  plies: number;
  color: "white" | "black";
  analysis: { evals: Eval[] };
}

const env = loadEnv();
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
const started = Date.now();

const candidates = await Game.find(
  {
    platform: "lichess",
    "analysis.status": "imported",
    $or: [{ "analysis.classifications": { $exists: false } }, { "analysis.classifications": { $size: 0 } }],
  },
  { sourceId: 1, plies: 1, color: 1, "analysis.evals": 1 },
).lean<Candidate[]>();

// The same Lichess game can be stored once per tracked player (both players in our DB).
const bySourceId = new Map<string, Candidate[]>();
for (const c of candidates) bySourceId.set(c.sourceId, [...(bySourceId.get(c.sourceId) ?? []), c]);
const ids = [...bySourceId.keys()];

console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${candidates.length} imported Lichess games without classifications`);
console.log(`(${ids.length} distinct Lichess game ids, ${Math.ceil(ids.length / IDS_PER_REQUEST)} request(s) to Lichess)`);

const lichess = createPoliteClient({
  name: "Lichess",
  userAgent: userAgent(env.CONTACT_EMAIL),
  rateLimitWaitsMs: [60_000],
  timeoutMs: 30_000,
});
const fetched = new Map<string, LichessGame>();
for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
  const chunk = ids.slice(i, i + IDS_PER_REQUEST);
  const params = new URLSearchParams({ evals: "true", moves: "true", tags: "false", clocks: "false" });
  await lichess.streamLines(
    `https://lichess.org/api/games/export/_ids?${params}`,
    (line) => {
      const game = JSON.parse(line) as LichessGame;
      fetched.set(game.id, game);
    },
    { method: "POST", body: chunk.join(","), headers: { Accept: "application/x-ndjson", "Content-Type": "text/plain" } },
  );
}

const sameEvals = (a: Eval[], b: Eval[]) =>
  a.length === b.length && a.every((e, i) => (e.cp ?? null) === (b[i]!.cp ?? null) && (e.mate ?? null) === (b[i]!.mate ?? null));

const counts = {
  withLichessJudgements: 0,
  notReturnedByLichess: 0, // deleted or closed account: fall back to our formula
  evalsChanged: 0, // Lichess re-analysed the game since import: skipped, a re-import is cleaner
  labels: { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 } as Record<string, number>,
  playerLabels: { inaccuracy: 0, mistake: 0, blunder: 0 } as Record<string, number>,
  // How our own formula compares with Lichess on these games (the classify.test.ts check, at scale).
  formula: { lichessJudged: 0, agreed: 0, differentSeverity: 0, missed: 0, extra: 0 },
};
const updates: { _id: mongoose.Types.ObjectId; set: Record<string, unknown> }[] = [];

for (const [sourceId, docs] of bySourceId) {
  for (const doc of docs) {
    const evals = doc.analysis.evals.map((e): Eval => (e.mate !== undefined && e.mate !== null ? { mate: e.mate } : { cp: e.cp }));
    const game = fetched.get(sourceId);
    let judgments: (Judgement | null)[] | undefined;
    let best: (string | null)[] | undefined;

    if (!game) {
      counts.notReturnedByLichess++;
    } else {
      const parsed = parseLichessAnalysis(game.analysis, doc.plies);
      if (!parsed || !sameEvals(parsed.evals!, evals)) {
        counts.evalsChanged++;
        continue;
      }
      counts.withLichessJudgements++;
      judgments = parsed.judgments;
      best = parsed.best;

      const ours = classifyGame({ evals });
      judgments!.forEach((theirs, i) => {
        if (theirs) {
          counts.formula.lichessJudged++;
          if (ours[i] === theirs) counts.formula.agreed++;
          else if (ours[i] === "good") counts.formula.missed++;
          else counts.formula.differentSeverity++;
        } else if (ours[i] !== "good") counts.formula.extra++;
      });
    }

    const classifications = classifyGame({ evals, judgments });
    classifications.forEach((label, i) => {
      counts.labels[label]!++;
      const mover = i % 2 === 0 ? "white" : "black";
      if (mover === doc.color && label in counts.playerLabels) counts.playerLabels[label]!++;
    });
    updates.push({
      _id: doc._id,
      set: {
        "analysis.classifications": classifications,
        "analysis.accuracy": averageAccuracy(evals, doc.color),
        ...(best?.some((b) => b !== null) ? { "analysis.best": best } : {}),
      },
    });
  }
}

console.log(JSON.stringify({ ...counts, gamesToUpdate: updates.length }, null, 2));

if (APPLY && updates.length > 0) {
  const res = await Game.bulkWrite(
    updates.map(({ _id, set }) => ({
      updateOne: { filter: { _id, "analysis.status": "imported" }, update: { $set: set } },
    })),
    { ordered: false },
  );
  console.log(`Wrote ${res.modifiedCount} of ${updates.length} games.`);
} else if (!APPLY) {
  console.log("Dry run: nothing written. Run again with --apply to write.");
}
console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)} s`);
await mongoose.disconnect();
