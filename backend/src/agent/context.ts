import type { Types } from "mongoose";
import type { Platform } from "../db/models/player.js";

// What every coach tool runs against. Built by the server from the URL's player
// (/api/players/:platform/:username/report), never from anything the model says: no tool takes
// a player argument, so the model can only ever read the player the run was started for.
export interface AgentContext {
  playerId: Types.ObjectId;
  platform: Platform;
}
