// One-off: builds src/chess/fixtures/lichess-division.json, the test oracle for chess/phase.ts.
//
// Lichess's game export can include `division` ("Plies which mark the beginning of the
// middlegame and endgame. Only available in JSON", lichess-org/api, games/api-games-user-username.yaml,
// read 3 Nov 2026). Lichess computes it with scalachess's Divider, the code chess/phase.ts
// ports, so its answers are the ground truth our port is tested against.
//
// Polite like the importers: one request at a time, a User-Agent with contact, and a full
// minute's wait on 429.
//   npm run fetch:division-fixture
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USERS = ["EricRosen", "DrNykterstein"];
const PER_USER = 100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "chess", "fixtures", "lichess-division.json");

interface ExportedGame {
  id: string;
  variant: string;
  moves?: string;
  initialFen?: string;
  division?: { middle?: number; end?: number };
}

const contact = process.env.CONTACT_EMAIL;
if (!contact) throw new Error("CONTACT_EMAIL is not set (it goes in the User-Agent)");
const headers = { Accept: "application/x-ndjson", "User-Agent": `Blunderprint/1.0 (contact: ${contact})` };

async function fetchUser(user: string): Promise<ExportedGame[]> {
  const params = new URLSearchParams({
    max: String(PER_USER),
    rated: "true",
    perfType: "bullet,blitz,rapid,classical",
    moves: "true",
    division: "true",
    clocks: "false",
    evals: "false",
    opening: "false",
  });
  for (;;) {
    const res = await fetch(`https://lichess.org/api/games/user/${user}?${params}`, { headers });
    if (res.status === 429) {
      console.log("429 from Lichess: waiting 60 s");
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    if (!res.ok) throw new Error(`Lichess answered ${res.status} for ${user}`);
    const text = await res.text();
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ExportedGame);
  }
}

const games: { id: string; moves: string; division: { middle?: number; end?: number } }[] = [];
for (const user of USERS) {
  const fetched = await fetchUser(user); // awaited before the next user: serial
  // Standard games from the normal start only: Divider runs on those, and so do we.
  const kept = fetched.filter((g) => g.variant === "standard" && !g.initialFen && g.moves);
  console.log(`${user}: ${fetched.length} fetched, ${kept.length} kept`);
  for (const g of kept) games.push({ id: g.id, moves: g.moves!, division: g.division ?? {} });
}

writeFileSync(OUT, JSON.stringify({ source: "lichess.org/api/games/user (division=true)", fetchedAt: new Date().toISOString(), games }, null, 0) + "\n");
console.log(`Wrote ${games.length} games to ${OUT}`);
