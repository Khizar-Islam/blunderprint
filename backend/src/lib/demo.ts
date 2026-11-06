import type { Platform } from "../db/models/player.js";

// Demo players (env DEMO_PLAYERS): the accounts the landing page shows. They are FROZEN, so a
// recruiter's visit can never change what the demo shows:
// - POST import answers 200 { upToDate: true, frozen: true } once they have been imported (the
//   first import still runs, to seed them), so no new games arrive and no old ones are trimmed.
// - POST /analysis/claim hands out no games for them, so a visitor's browser never analyses one
//   and the coach report never goes stale mid-demo.
// - Their current coach report's run (the trace behind "How this report was made") never expires
//   (agent/runExpiry.ts).
// Their data is completed by hand before they're added to DEMO_PLAYERS.

export type IsDemo = (platform: string, username: string) => boolean;

// keys: "platform:usernamelower" (config/env.ts parseDemoPlayers).
export function demoChecker(keys: readonly string[]): IsDemo {
  const set = new Set(keys);
  return (platform, username) => set.has(`${platform}:${username.toLowerCase()}`);
}

export const noDemoPlayers: IsDemo = () => false;

// "lichess:drnykterstein" → { platform, usernameLower }, for database lookups.
// Only for keys from parseDemoPlayers, whose platform part is already checked.
export function demoKeyParts(key: string): { platform: Platform; usernameLower: string } {
  const at = key.indexOf(":");
  return { platform: key.slice(0, at) as Platform, usernameLower: key.slice(at + 1) };
}
