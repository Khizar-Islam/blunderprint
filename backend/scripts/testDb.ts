import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { AgentRun } from "../src/db/models/agentRun.js";
import { Answer } from "../src/db/models/answer.js";
import { Game } from "../src/db/models/game.js";
import { Job } from "../src/db/models/job.js";
import { Player } from "../src/db/models/player.js";
import { Report } from "../src/db/models/report.js";
import { Usage } from "../src/db/models/usage.js";

// A throwaway MongoDB for one test file: a real mongod binary (version pinned in package.json
// "config.mongodbMemoryServer" to match Atlas's 8.0), started on a random port, data in a temp
// folder. Nothing touches Atlas.
export async function startTestDb(): Promise<{ stop: () => Promise<void> }> {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "test" });
  // Build the indexes up front: the unique and partial indexes are part of what we test.
  await Promise.all([Player.init(), Game.init(), Job.init(), Report.init(), AgentRun.init(), Usage.init(), Answer.init()]);
  return {
    async stop() {
      await mongoose.disconnect();
      await server.stop();
    },
  };
}

export async function clearDb(): Promise<void> {
  await Promise.all([
    Player.deleteMany({}),
    Game.deleteMany({}),
    Job.deleteMany({}),
    Report.deleteMany({}),
    AgentRun.deleteMany({}),
    Usage.deleteMany({}),
    Answer.deleteMany({}),
  ]);
}
