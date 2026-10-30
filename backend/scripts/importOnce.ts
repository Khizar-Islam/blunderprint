// Imports one player into the real database, for trying the queue and importers before the
// routes exist. Usage (from backend/):  npm run import:once -- chesscom someusername
import mongoose from "mongoose";
import { loadEnv } from "../src/config/env.js";
import { Job } from "../src/db/models/job.js";
import { Player } from "../src/db/models/player.js";
import { Game } from "../src/db/models/game.js";
import { importJobKey } from "../src/jobs/handlers/import.js";
import { createJobSystem } from "../src/jobs/setup.js";
import { startWorker } from "../src/jobs/worker.js";

const [platform, username] = process.argv.slice(2);
if ((platform !== "chesscom" && platform !== "lichess") || !username) {
  console.error("Usage: npm run import:once -- <chesscom|lichess> <username>");
  process.exit(1);
}

const env = loadEnv();
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
await Promise.all([Player.init(), Game.init(), Job.init()]); // make sure the indexes exist

const { queue, handlers } = createJobSystem(env);
const { job, created } = await queue.enqueue({
  type: "import",
  key: importJobKey(platform, username),
  payload: { platform, username },
});
console.log(created ? `Queued job ${job._id}` : `Job ${job._id} was already queued or running`);

const worker = startWorker({ queue, handlers });
process.on("SIGINT", () => {
  console.log("Ctrl+C: releasing the job and stopping");
  void worker.stop().then(() => mongoose.disconnect()).then(() => process.exit(130));
});

// Print progress until the job finishes.
const started = Date.now();
let lastMessage = "";
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const current = await Job.findById(job._id).lean();
  if (!current) break;
  const line = `[${current.status}] ${current.progress?.done ?? 0}/${current.progress?.total ?? "?"} ${current.progress?.message ?? ""}`;
  if (line !== lastMessage) console.log(line);
  lastMessage = line;
  if (current.status === "done" || current.status === "failed") {
    if (current.status === "failed") console.log(`Error: ${current.error?.message}`);
    break;
  }
}

const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }).lean();
if (player) console.log(`Player ${player.username}: ${player.gamesCount} games, ${player.analysedCount} already analysed`);
console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)} s`);
await worker.stop();
await mongoose.disconnect();
