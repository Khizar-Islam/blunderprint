# CLAUDE.md: Blunderprint (AI chess coach agent)

Claude Code reads this file automatically at the start of every session. It is the single source of truth for the project: how I work, what we are building, how it is built, the order we build it in, and what is likely to go wrong.

There is a **separate companion document**, `blunderprint-chat-companion.md`, for my Claude.ai chat. That chat handles what you can't do from a terminal: creating accounts, dashboards, deployment checks, and live testing in the browser. The two are used side by side.

"Blunderprint" is a working name. If I rename it, update this file, the README and the package names together.

---

## 1. How to work with me

- I'm a 3rd-year Software Engineering student, and this is a portfolio project for job applications (junior MERN/full-stack roles in Karachi). I read code fine. Explain anything new to me, such as a library, a MongoDB feature or an agent pattern, in plain words the first time it comes up. I have to be able to explain every layer in an interview.
- **Plan before code.** At the start of each stage, give me a short plan (files to create or change, and why) and wait for my OK. Inside an approved stage, make judgment calls yourself and tell me in one line what you chose and why.
- **Small steps.** Build one piece, tell me what it does and how to try it, then move on. Don't dump 15 files at once.
- **Errors:** when something breaks, tell me in one line what actually went wrong before showing the fix.
- **Ask first** before anything destructive: dropping or clearing collections, deleting files with real work in them, force-pushing, or rewriting git history.
- **Git:** stage files by name, never `git add -A` or `git add .`, and never commit the `.claude/` folder (it's my local settings). Don't commit or push until I approve the diff. After I approve, commit, push, and tell me the commit hash. Commit messages carry no Co-Authored-By or other AI attribution trailer; I'll say so if that changes.
- **Reports:** at the end of each task, give me `git status`, the full `git diff` as plain text (use `--ignore-cr-at-eol`, because I'm on Windows with CRLF checkouts), the test results, and anything you're unsure about.
- **My machine:** Windows, cmd terminal, VS Code, **8 GB RAM**. Don't run heavy jobs (the dataset import) while dev servers and the browser are running. Commands must work in Windows cmd.
- **At the start of a dev session,** list every terminal I need and what state it should be in. Assume nothing is running.
- **Secrets:** never print values from `.env` files. Variable names only.
- **Verify before assuming:** library versions, Gemini model names, API parameters. Things change fast, and we've been burned by deprecated Gemini models before.
- I use your `/plan`, `/status` and `/verify` commands. Use `/verify` before reporting a stage done.

---

## 2. What we're building

**One sentence:** enter any Chess.com or Lichess username, and Blunderprint imports the games, finds the mistakes with a chess engine running in your browser, compares your positions against millions of real games, and then an AI coach agent investigates the data with tools and explains your *recurring* weaknesses, with evidence from your own games.

**The 60-second demo:**
1. Open the site and type a username (mine, or a famous player's).
2. Games stream in live. Then each game's "move ribbon" fills tick by tick as the engine analyses it in the browser.
3. The dashboard shows the **Blunderprint**: a heat map of where and when you go wrong.
4. Click "Coach me". The agent's steps appear live: it queries openings, pulls mistake breakdowns, looks up what stronger players do in your critical positions, and checks its own claims.
5. You get 3 to 5 patterns, each with real positions from your games, a statistic, and a drill.

**No sign-in in v1.** The games are public data, so there's no login wall for recruiters. Everything is keyed by platform + username.

**Why this is "big" (the interview story):**
- **Data scale:** a position-statistics collection built from millions of Lichess games (CC0 public data), plus every imported player's games. Indexes, aggregation pipelines, cursor pagination and a storage budget all actually matter.
- **AI depth:** a real tool-using agent. It plans, calls tools against MongoDB, loops, and stops at a step budget. A verifier checks every claim against the data and forces a repair round when a claim can't be backed up. It's not one prompt.
- **Systems depth:**
  - A MongoDB-backed job queue with leases, retries, backoff and idempotency.
  - Polite rate-limited importers (Chess.com: one request at a time; Lichess: one at a time, wait a minute on 429).
  - Browser-side engine workers that claim work from the server.
  - Live progress over Server-Sent Events (SSE), caching, per-visitor limits and a global AI budget.
  - Storage eviction to stay inside the free 512 MB.

---

## 3. Architecture

```
  Browser (Next.js on Vercel)
  ├─ pages: landing, player dashboard, game review, coach report
  ├─ Stockfish 19 lite single-threaded (WASM) in 1–2 Web Workers
  │     claims unanalysed games → analyses → posts evals back
  └─ EventSource (SSE) for live job + agent progress
            │  HTTPS + CORS (allowlist)
            ▼
  API (Express + TypeScript on Render, free tier)
  ├─ REST routes + SSE routes
  ├─ Job worker loop (same process): import → extract → aggregate → report
  ├─ Importers: Chess.com PubAPI, Lichess API (serial, polite, retrying)
  ├─ Coach agent: Gemini function calling ↔ tools (read-only Mongo queries)
  └─ Guards: rate limits (per IP), AI budget, storage guard, error handler
            │
            ▼
  MongoDB Atlas M0 (free, 512 MB) via Mongoose
  ├─ players, games, jobs, reports, agentRuns, usage
  ├─ openings (Lichess chess-openings, CC0)
  └─ positionStats (built offline from Lichess games, CC0)
            ▲
            │  one-off, run on my laptop
  scripts/import-positions (reads Lichess parquet shards → aggregates → bulkWrite)
```

**Why the engine runs in the browser:** Render's free CPU is far too slow for Stockfish, and a paid worker breaks the "free to keep live" budget. The visitor's own CPU does the work for free. The server stays in control: it hands out work, validates results, and stores them idempotently.

**Why the job worker lives in the API process:** Render has no free background workers. Jobs live in MongoDB, so when the free instance sleeps, the jobs simply pause. Expired leases are picked up again when it wakes. That resume-after-sleep behaviour is a deliberate design point to explain in interviews.

---

## 4. Tech stack (verify versions at the start of Stage 0)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js (App Router, TypeScript), Tailwind CSS v4, `motion` (the package formerly called Framer Motion; import from `motion/react`) | Same family as my other projects. Check the current Next.js version. |
| Board | `react-chessboard` (MIT) | Not Chessground: it's GPL and Lichess-styled. Custom board colours (section 12). |
| Chess logic | `chess.js` | PGN parsing, legal moves, FEN, on both the frontend and the backend. |
| Engine | npm `stockfish` v19, **lite single-threaded** build (~1.7 MB) | Runs in a Web Worker with no COOP/COEP headers needed. The multi-threaded builds need cross-origin isolation, so don't use them. GPL-3.0: see gotchas. |
| Backend | Node.js 22 LTS, Express, TypeScript (`tsx` for dev), `zod` for validation | Node 22.13+ is also needed by the MongoDB MCP server. |
| TypeScript | **Pinned to 6.0.3** (exact version) in both `backend/` and `web/` | Not TS 7 for now: TS 7 is the new native (Go) compiler, and tools that use the TypeScript JS API, like Next's build-time type check, may not support it yet. |
| Database | MongoDB Atlas M0 (free, 512 MB), **Mongoose** | Mongoose because MERN job ads expect it. Use `Model.aggregate()` for pipelines and `bulkWrite` for imports. |
| AI | Google Gemini via `@google/genai` | Model from env `GEMINI_MODEL`. **Dev and the free demo use `gemini-3.5-flash-lite`:** on the free tier it gets 500 requests/day (15 RPM, 250K TPM), while `gemini-3.8-flash` gets only 20/day. Switch to `gemini-3.8-flash` at Stage 8 with the paid credit. Both were listed as stable on 30 Oct 2026. **Before Stage 5, verify that `gemini-3.5-flash-lite` supports function calling and structured output.** |
| Tests | `node:test` (same style as Footnote), `mongodb-memory-server` for queue/DB tests | mongodb-memory-server works on my Windows machine (verified in Stage 1), with the MongoDB binary pinned to 8.0.34 in `backend/package.json` (`config.mongodbMemoryServer`). |
| Hosting | Vercel (web), Render free web service (API) | The API sleeps after 15 minutes idle, so the UI must handle the wake-up (section 10). |
| Dev tooling | Official MongoDB MCP server in **read-only** mode | Lets you inspect collections and explain plans safely. Setup is in the companion doc. |

---

## 5. Repository layout

```
blunderprint/
├─ CLAUDE.md
├─ README.md                 (architecture diagram, demo GIF, decisions, numbers)
├─ backend/
│  ├─ src/
│  │  ├─ app.ts              (createApp(): middleware order, routes, error handler)
│  │  ├─ server.ts           (listen + start worker loop)
│  │  ├─ shutdown.ts         (graceful shutdown order, section 13)
│  │  ├─ config/env.ts       (zod-validated env, parseTrustProxyHops, CORS list)
│  │  ├─ db/                 (mongoose connect, models/*.ts, indexes)
│  │  ├─ jobs/               (queue.ts, worker.ts, events.ts in-process job event bus,
│  │  │                       errors.ts, setup.ts, handlers/*.ts)
│  │  ├─ importers/          (chesscom.ts, lichess.ts, politeFetch.ts, normalize.ts)
│  │  ├─ chess/              (fen.ts normalize, classify.ts win%, features.ts, openings.ts)
│  │  ├─ agent/              (tools/*.ts, loop.ts, verifier.ts, prompts.ts, schema.ts)
│  │  ├─ routes/             (players, games, jobs (SSE stream), analysis, positions, coach, health)
│  │  ├─ middleware/         (requestId.ts, errorHandler.ts, rateLimit.ts, budget.ts)
│  │  └─ lib/                (logger.ts, sse.ts helpers, cursor.ts pagination cursors,
│  │                          validate.ts zod → 400, sleep.ts, version.ts)
│  ├─ scripts/               (test helpers: testDb, testServer, fakeFetch, fixtures, sseClient;
│  │                          importOnce, explainGames)
│  └─ .env.example
├─ docs/explain/             (saved .explain() output for the README)
├─ web/
│  ├─ src/app/               (/, /p/[platform]/[username], /p/.../game/[id], /p/.../coach)
│  ├─ src/lib/               (api.ts, useJobStream.ts, useWakingRequest.ts, format.ts)
│  ├─ src/components/        (PlayerSearch, PlayerDashboard, ImportProgress, GamesList, HealthStatus,
│  │                          MotionProvider; later Board, MoveRibbon, Blunderprint, EvalGraph,
│  │                          AgentTrace, PatternCard)
│  ├─ src/engine/            (stockfish worker wrapper, analysis scheduler)
│  ├─ public/engine/         (stockfish-19-lite-single.js + .wasm + its LICENSE)
│  └─ .env.example
└─ scripts/
   └─ import-positions/      (offline: Lichess parquet → positionStats)
```

---

## 6. Data sources and their rules

**Chess.com Published-Data API** (`https://api.chess.com/pub/...`, read-only, public data, no key)
- `GET /pub/player/{username}/games/archives` lists monthly archive URLs. Then `GET /pub/player/{username}/games/{YYYY}/{MM}` returns the JSON games for that month (each includes a PGN).
- **Serial requests only.** Wait for each response before sending the next. Parallel requests can get `429`, and suspicious traffic can get the app blocked.
- Send a `User-Agent` with contact info: `Blunderprint/1.0 (contact: <CONTACT_EMAIL>)`.
- Data refreshes at most every 12–24 hours, so very recent games may be missing. Say so in the UI.
- Use `ETag`/`If-None-Match` on re-imports.
- Skip non-standard games (variants such as Chess960) and keep standard rules only.
- **Brand rule:** don't use Chess.com's board colours, piece sets or sounds.

**Lichess API**
- Export a user's games as NDJSON (`Accept: application/x-ndjson`). Request clocks, existing evals and the opening. **Verify the exact endpoint and parameter names** (`max`, `clocks`, `evals`, `opening`, `perfType`, `rated`) in the official docs at lichess.org/api before coding.
- **One request at a time across the whole app.** On `429`, wait a full minute.
- If a game already has Lichess computer analysis, keep its evals and skip our engine for it. That saves time.

**Lichess game database** (CC0): the Hugging Face dataset `Lichess/standard-chess-games`, partitioned by year/month into ~170 MB parquet shards.
- Used **only offline**, by `scripts/import-positions`, to build `positionStats`.
- Read the parquet schema first (expected: headers such as `WhiteElo`, `BlackElo`, `Result`, `TimeControl`, `ECO`, and the movetext). Don't assume column names.

**Lichess chess-openings** (CC0): TSV files `a.tsv`–`e.tsv` (eco, name, pgn; the generated files add uci and epd).
- Imported into `openings` to name openings by position.

**Ratings differ between sites.** A Chess.com 1500 is not a Lichess 1500. `positionStats` uses Lichess rating bands. Map a Chess.com player to a band with a documented rough offset or a wider band, and show "approximate" in the UI. Don't present it as exact.

---

## 7. MongoDB data model (Mongoose)

Field names in camelCase. Every collection gets `createdAt`/`updatedAt` unless noted. **Indexes are part of the design.** Explain each one in a comment, and check the important queries with `.explain()` (save the results for the README).

### players
```
{ _id, platform: "chesscom"|"lichess", username, usernameLower,
  profile: { ratings: { blitz, rapid, bullet }, avatarUrl?, country? },
  importState: "idle"|"importing"|"ready"|"failed", lastImportedAt,
  gamesCount, analysedCount,
  summary: { ...precomputed aggregates for the dashboard... }, summaryVersion,
  lastViewedAt,           // used by the storage guard (LRU eviction)
  importMeta: {           // what a re-import needs to fetch only what's new
    monthEtags: { "YYYY/MM": etag },  // Chess.com month ETags; a 304 means that month is unchanged
    newestGameAt } }      // newest stored game in platform time (Chess.com end_time, Lichess createdAt,
                          // because Lichess's `since` filters on createdAt); set only when an import finishes
```
Indexes: unique `{ platform, usernameLower }`; `{ lastViewedAt: 1 }`.

### games
```
{ _id, playerId, platform, sourceId (platform game id/url), playedAt,
  color, result: "win"|"loss"|"draw", termination, timeControl, speed: "bullet"|"blitz"|"rapid"|"classical"|"daily",
  playerRating, opponentRating, opponentName,
  pgn,                       // keep: needed for replay
  plies: number,
  clocks?: [number],         // seconds remaining per ply, when available
  opening: { eco, name, ply }  // deepest matching named position
  analysis: {
    status: "pending"|"claimed"|"done"|"imported",  // imported = came with Lichess evals
    claimedBy?, claimExpiresAt?, engine: "sf19-lite", depthOrNodes,
    evals: [ { cp?: number, mate?: number } ],      // per ply, from White's view
    classifications: [ "best"|"good"|"inaccuracy"|"mistake"|"blunder" ],
    accuracy? }
  features: { mistakes: [ { ply, kind, phase, winDrop, clockLeft?, square?, pieceLost?, fen } ] } }
```
Indexes:
- unique `{ playerId, sourceId }` (idempotent import). Keyed by player, not `{ platform, sourceId }`: if two players we track played each other, the game is stored once per player, because `color` and `result` are per player. With `{ platform, sourceId }` the second import would overwrite the first player's copy.
- `{ playerId, playedAt: -1, _id: -1 }` (cursor pagination). `_id` breaks ties between games with the same `playedAt`, so the index alone gives the full sort order (no in-memory sort).
- `{ playerId, "analysis.status": 1 }` (work claiming); `{ playerId, "opening.eco": 1 }`.
Keep only the **most recent N games per player** (env `MAX_GAMES_PER_PLAYER`, default 200).

### jobs (the queue)
```
{ _id, type: "import"|"extract"|"aggregate"|"report", key (idempotency key, e.g. "import:chesscom:hikaru"),
  payload, status: "queued"|"running"|"done"|"failed",
  attempts, maxAttempts, runAfter, leaseUntil, workerId,
  progress: { done, total, message },
  checkpoint?,           // handler's resume point, e.g. Chess.com months done / oldest Lichess createdAt
  error? }               // { code, message }, safe to show the user
```
Indexes: `{ status: 1, runAfter: 1 }`; unique partial index on `key` where status is queued or running, so the same job can't be queued twice.

### positionStats (the big dataset)
```
{ _id: "<normalizedFen>|<band>", fen, band: "0-1199"|"1200-1599"|"1600-1999"|"2000+",
  total, moves: [ { uci, san, w, d, l } ] }   // top moves only, sorted by count
```
`_id` doubles as the lookup key (no extra index). Built offline (section 9).

### openings
`{ eco, name, pgn, uci, epd }`, index `{ epd: 1 }`.

### reports and agentRuns
```
reports: { playerId, analysedGamesHash, promptVersion, model, patterns: [...], createdAt }
agentRuns: { playerId, kind: "report"|"ask", steps: [ { tool, args, resultSummary, ms } ],
             tokensIn, tokensOut, status, error? }
```
`reports` index: `{ playerId, analysedGamesHash, promptVersion }`, used as the cache key. Index `agentRuns` on `createdAt` with a TTL (e.g. 14 days) to keep storage bounded.

### usage (limits and AI budget)
`{ _id: "<scope>|<yyyy-mm-dd>", count }`. Scopes: `ip:<hash>` (hash the IP, don't store it raw) and `global:ai`. TTL index so old days disappear.

### Storage budget (enforced, not hoped for)

| Data | Budget |
|---|---|
| positionStats + openings | ≤ 300 MB including indexes |
| players + games + reports + runs | ≤ 150 MB |
| Headroom | ~60 MB |

A **storage guard** job runs after imports. It reads `dbStats`, and over the threshold it evicts the least-recently-viewed players (their games, reports and runs), never the demo players (`DEMO_PLAYERS` env). Atlas M0 storage limits must be confirmed in Stage 0. The guard keeps us safe either way.

---

## 8. Core pipelines

### 8.1 Import (job `import`)
1. Validate the username (platform's allowed characters and length) and confirm the player exists.
2. Fetch games newest-first, serially, until `MAX_GAMES_PER_PLAYER` is reached. Report progress after each month or chunk.
   - **Chess.com:** re-imports send `If-None-Match` with the stored **month** ETag (a 304 skips the month) and stop at the newest stored game's month. The archive *list* gets no ETag: a 304 there wouldn't mean "no new games", because the current month can still change. In a busy month (1,000+ games), cheap checks run first and only the newest games still needed are normalized.
     - **Plies are counted from the PGN text, not by replaying it with chess.js** (`countPliesFromText`: strip headers, comments, variations, move numbers, NAGs and the result, then count the SAN tokens; anything that isn't SAN-shaped rejects the game). On a real 212-game month it agreed with chess.js on every game. Legality isn't checked here: Stage 2's browser engine replays every game, and the server checks the eval count against `plies`.
     - **Why:** chess.js cost ~8 ms a game on my laptop but **~110–160 ms a game on Render's free CPU**, so a busy month blocked the event loop for seconds (`/api/health` up to **1.3 s** server-side, 9.4 s end to end). With the text count it's **~2 ms a game on Render** (374-game month: 0.4 s instead of ~13 s) and `/api/health` stayed under **27 ms** during processing.
     - **Safety net:** the loop yields to the event loop once **~50 ms** have passed (time-based, not every N games, because the cost per game differs so much between machines), so `/api/health`, SSE and lease renewal keep running.
   - **Lichess:** plies are counted from the export's `moves` field (SAN moves separated by spaces) instead of replaying the PGN with chess.js (measured: ~8 ms a game on my laptop, ~110–160 ms on Render). Batches are stored in the background while the stream keeps flowing, so a slow DB write never trips the stream's idle timeout.
3. Upsert each game by `{ playerId, sourceId }`: this is idempotent, so re-imports never duplicate. `analysis` is written only on insert, so a re-import never wipes evals.
4. Set `analysis.status` to `imported` when Lichess evals came with the game, otherwise `pending`.
5. Update `players.importState`. Enqueuing `extract` for games that already have evals waits until Stage 3, when the `extract` handler exists (until then those jobs would fail as an unknown type).
6. Errors: on 404 the user doesn't exist (fail cleanly); on 429 back off (Lichess: 60 s); network errors retry with exponential backoff up to `maxAttempts`.

### 8.2 Browser engine analysis
1. The web app asks `GET /api/analysis/claim?player=...` and receives up to K pending games (K≈3). The server marks them `claimed` with a 10-minute `claimExpiresAt`.
2. The engine runs in 1–2 Web Workers (based on `navigator.hardwareConcurrency`). It evaluates the position after every ply with a fixed **node or time budget**, not unbounded depth, so the time per game is predictable. **Measure in Stage 2** and pick settings that keep a typical game under about 15 seconds.
3. It posts `POST /api/analysis/results` with per-ply evals. The server validates the eval count against the plies, bounded values, and that the claim is still valid. It then classifies the moves, stores the result, and enqueues `extract`.
4. Expired claims go back to `pending`, so a closed tab never loses work. Anyone viewing the player later continues the analysis.
5. **Classification:** convert centipawns to win% the way Lichess does, then classify by the size of the win% drop (inaccuracy, mistake, blunder). **Read the exact formula and thresholds from Lichess's open-source code before implementing,** and cite it in a comment. Handle mate scores explicitly.

### 8.3 Feature extraction (job `extract`) and aggregation (job `aggregate`)
- **Per game:**
  - Opening: deepest match of a normalized position against `openings.epd`.
  - Each mistake gets: phase (opening/middlegame/endgame by ply plus remaining material), clock left (time trouble when below 10% of the starting time), the square involved, any piece lost within 2 plies, and the FEN.
- **Per player:** aggregation pipelines (`$match`, `$unwind`, `$group`, `$bucket`, `$facet`) produce the dashboard summary: score by opening and colour, mistakes per game by phase, speed, clock bucket and move number, and the square heat map. Store it in `players.summary` with a version number.
- Explain each pipeline stage in comments. These pipelines are prime interview material.

### 8.4 FEN normalization (used everywhere positions are compared)
- Keep only the first 4 FEN fields (pieces, side to move, castling rights, en-passant square). Drop the move counters.
- Keep the en-passant square **only if an en-passant capture is actually legal**, so identical positions match across both sites and the Lichess data.
- Unit-test this heavily. If it's wrong, position lookups silently miss.

---

## 9. Offline import: `positionStats` (Stage 4)

`scripts/import-positions` runs **on my laptop, once**, never on Render.

1. Download 1 parquet shard of `Lichess/standard-chess-games` into a dedicated folder. **Print the schema and 3 sample rows first.**
2. Pick a parquet reader that works on Windows (DuckDB or a pure-JS reader). Choose, tell me why, and test it on one shard.
3. **Filter:** rated standard games, blitz/rapid/classical, both players in the same rating band.
4. For each game, replay the first **16 plies** with chess.js, normalize each position, and count the next move with its result, per band.
5. Aggregate in memory with a **size-capped map**. When it's full, flush with `bulkWrite` upserts (`$inc`) in batches of ~1,000. Watch memory: I have 8 GB.
6. After all the shards: drop positions seen fewer than `MIN_POSITION_GAMES` times (start at 20), and keep the top 8 moves per position.
7. Print a report: games read, games kept, positions written, collection size, index size and time taken.
8. **Scale up stepwise.** Measure one shard, estimate the size per shard, then decide how many shards fit inside 300 MB. Tell me the numbers before importing more.

The script must be **resumable and idempotent**. Track the processed shards in a small `importLog` collection so a crash doesn't double-count.

---

## 10. The coach agent

### Tools (read-only, return **compact aggregated JSON**, never raw game dumps; ≤ ~2k tokens each)

| Tool | Purpose |
|---|---|
| `get_player_profile()` | Ratings, games analysed, speeds, colour split, overall accuracy |
| `get_opening_breakdown({ color?, speed?, minGames })` | Per opening: games, score %, mistakes per game |
| `get_mistake_breakdown({ groupBy, filters })` | groupBy: phase, speed, clockBucket, moveNumberBucket, pieceLost, square |
| `find_example_mistakes({ filters, limit ≤ 5 })` | `{ gameId, ply, fen, played, bestHint?, winDrop, clockLeft }` |
| `get_position_stats({ fen, band })` | What players in a band play from this position, with results (from positionStats) |
| `get_game_summary({ gameId })` | Opening, result, key moments |

All tools take the player from the server context, never from the model, so the model can't query other players.

### Loop (`agent/loop.ts`)
1. A system prompt (versioned as `PROMPT_VERSION`) sets the job: find 3–5 **recurring** patterns. Every claim needs evidence (game IDs and plies) and a statistic taken from the tool results. Say "not enough data" instead of guessing.
2. Gemini function calling: run tool calls, append the results, and repeat. Hard limits: **max 10 steps**, a total token budget, and a per-call timeout.
   - **Rate limit:** the free tier allows 15 requests per minute for `gemini-3.5-flash-lite`. Pace model calls (at least 4 s apart, shared across all runs in the process) and back off on `429`, using Google's suggested retry delay when one is sent, while staying inside the step and token budget.
3. The final answer uses **structured output** with this schema:
   ```
   patterns: [ { title, explanation, stat: { value, basis }, evidence: [ { gameId, ply } ], drill } ]
   ```
4. **Verifier (code, not AI):**
   - Every evidence game and ply must exist for this player and be a classified mistake.
   - Every statistic must match a number that actually appeared in a tool result.
   - On failure, run **one repair round** that tells the model what failed. If it still fails, drop that pattern and note it.
5. Stream every step to the UI over SSE: the tool name, a short args summary, a short result summary and the time taken. That's the live "agent trace".
6. **Cache** reports by `(playerId, analysedGamesHash, PROMPT_VERSION)`. If nothing changed, return the cached report instantly with no AI calls.

### "Ask the coach" (Stage 6)
Follow-up questions use the same tools, capped at 6 steps, with the same evidence rules.

### Guards
- Per-IP limits (hashed IP): e.g. 5 imports/hour, 3 reports/day, 20 questions/day.
- Global daily AI call budget (`AI_DAILY_CALL_BUDGET`, default 400, under the 500/day free limit) and a kill switch (`AI_ENABLED=false`) that shows a friendly message.
- Free-tier note: on the free tier Google may use prompts to improve its models. That's fine here, because all the data is public games.
- When the budget runs out, show cached reports and an honest message. Never show a raw error.

---

## 11. API routes

```
GET  /api/health                                   → { ok, db, queueDepth, version }
POST /api/players/:platform/:username/import       → 202 { jobId } or 200 { upToDate: true } (idempotent: returns the running job)
GET  /api/players/:platform/:username              → { player, activeJob } (player: profile + importState + counts + summary)
GET  /api/players/:platform/:username/games        → cursor pagination (?cursor=&limit=&speed=&color=&result=)
GET  /api/games/:id                                → game + analysis + features
GET  /api/analysis/claim?platform=&username=       → up to K games to analyse (leases)
POST /api/analysis/results                         → evals for claimed games (validated, idempotent)
GET  /api/positions/stats?fen=&band=               → positionStats lookup
POST /api/players/:platform/:username/report       → { runId } or { cached report }
POST /api/players/:platform/:username/ask          → { runId }
GET  /api/jobs/:id/stream                          → SSE: job progress
GET  /api/runs/:id/stream                          → SSE: agent steps, then the final result
```

Rules:
- Validate every input with zod.
- **Cursor pagination,** not skip/limit.
- The SSE endpoints send a heartbeat comment every 15 s and close cleanly.
- **CORS also applies to EventSource,** so the allowlist must include the Vercel site.
- **POST import:** 202 `{ jobId }` starts (or rejoins) an import. 200 `{ upToDate: true }` when the last successful import is under **6 h** old and none is active (Chess.com only refreshes every 12–24 h anyway). Repeating the call is safe: while an import is queued or running, the same job comes back.
- **GET player:** `{ player, activeJob }`. `player` is null while a first import is still queued (the job creates the player once the platform confirms they exist); `activeJob` lets a reloaded page reattach to the stream. 404 only when there is neither.
- **Job SSE contract** (`GET /api/jobs/:id/stream`):
  - Events: `snapshot`, `progress`, `retrying`, `done`, `failed`. Every event's `data` is the whole public job, and its `id:` is the job's `rev` (a counter bumped on every change).
  - **Subscribe, then snapshot:** the route subscribes to the in-process event bus first, buffers, reads the job and sends it as `snapshot`, then sends only buffered/later events with `rev` greater than the snapshot's. Nothing is lost or duplicated in between.
  - `retry: 3000`, a heartbeat comment every 15 s, and the server ends the stream after `done`/`failed`. A reconnect always starts with a fresh snapshot.
  - A 429 is waited out inside the importer, so it doesn't produce a `retrying` event: the stream just goes quiet (the UI shows a hint after 20 s).

---

## 12. Frontend: pages, design and animation

### Pages
- `/`: landing. A pre-analysed demo player's Blunderprint animating, plus one input: username and platform toggle.
- `/p/[platform]/[username]`: dashboard. Import progress, then analysis progress, then the patterns dashboard, with a "Coach me" button.
- `/p/[platform]/[username]/game/[id]`: game review. Board, eval graph, move list with classifications, and a "what players at your level play here" panel.
- `/p/[platform]/[username]/coach`: the agent trace and the report.

### Design direction (no "AI slop")
- **Avoid:** purple-to-blue gradients, glowing borders, glassmorphism, blurred orbs, icon-in-circle feature blocks. Also don't copy Chess.com's green or Lichess's brown boards.
- **Palette (starting point, tell me if you change it):**
  - Ink `#1B1D1A`, Bone `#E9E4D8`, Graphite `#2B2B28`, Stone squares `#D8D2C4` / `#8C8675`.
  - Classifications: inaccuracy Amber `#D4A72C`, mistake Rust `#D9772B`, blunder Brick `#B3362B`, best/good Teal `#3E7C74`.
- **Type:** Newsreader (display serif, the "chess book" feel), Geist (UI), Geist Mono (notation, numbers, the agent trace).
- **Signature visual: the Blunderprint.**
  - Every analysed game is a thin horizontal **move ribbon**, one tick per move, coloured by classification.
  - Stacked, the ribbons form a fingerprint-like texture of the player's habits.
  - Beside it sits an 8×8 **heat board** of where mistakes happen.
  - Clicking a tick opens that exact position.
  - This is the one place to go big visually.

### Animation (generous and purposeful)
- Games drop into the list with a staggered reveal as the import streams in. The counter ticks up.
- Ribbons fill **tick by tick live** as the browser engine analyses. This is the hero moment, so make it feel alive.
- The eval graph draws itself. Dragging across it scrubs the board (tactile).
- Charts re-animate when filters change (colour, speed, date range).
- Agent trace lines type in one by one with the step timings. Pattern cards reveal staggered, and each card's board animates to the critical position.
- Every interactive element gets hover and press feedback.
- Respect `prefers-reduced-motion`.

### The cold-start UX
Render's free API sleeps after 15 minutes. The first request can take up to about a minute. Show a "Waking the server up… (Ns)" counter after 3 seconds, the same pattern as Interview Prep.

---

## 13. Security and operations (lessons from my last four projects, apply from day 1)

- **Error handler:** 5xx responses send a fixed message and log the real error. Only `err.statusCode` sets a 4xx, never `err.status` (SDK errors carry their own). If `res.headersSent`, call `next(err)`. Body-parser errors get fixed messages. Unknown `/api` routes return 404 JSON. Set an explicit body size limit.
- **Trust proxy:** read `TRUST_PROXY_HOPS` (0–5, default 0, invalid values warn and fall back to 0). On Render it must be **3** (visitor → Cloudflare → Render proxy). Set it before the rate limiters. Log a warning on Render when it's 0. Use express-rate-limit's `ipKeyGenerator` for IPv6.
- **CORS:** a fixed allowlist (localhost + the live Vercel URL) plus an optional `CORS_ORIGINS` env list, parsed strictly (no `*`, no paths). Ledger broke on this when the Vercel address changed.
- **Outbound politeness:** the global serial queues for Chess.com and Lichess, the User-Agent with contact, backoff, and timeouts on every fetch.
- **Logs:** structured one-line JSON logs with a request ID, the job ID and timings. `/api/health` reports the queue depth.
- **Engine results are untrusted input:** validate their shape and bounds. The worst a faked result can do is mislabel one player's own games.
- **Graceful shutdown** (`src/shutdown.ts`; SIGTERM on a Render redeploy, Ctrl+C locally), in this order:
  1. Stop accepting new connections (`server.close()`).
  2. Stop the worker: it aborts the running job, gives the handler **3 s** to wind down, then **releases** the job back to the queue with its attempt refunded, so the next process picks it up at once instead of waiting out the lease.
  3. Close the SSE streams (after step 2, so viewers still get the `retrying` event). EventSource reconnects to the new instance and gets a fresh snapshot.
  4. Give in-flight requests **2 s** to drain, then cut the remaining connections.
  5. Disconnect from MongoDB (last, because the release needs it).
  - A **10 s** force-exit timer covers anything that hangs (Render waits 30 s before SIGKILL).
  - **Both kill tests passed (31 Oct 2026):** a hard kill mid-import was requeued by the lease reaper and resumed with 0 duplicates (Zhigalko_Sergei, 1,998 games); a graceful Ctrl+C released the job at once and the shutdown finished in 3.1 s (EricRosen); the released job was picked up and finished on the next start.

---

## 14. Environment variables

**backend/.env** (names only; real values never go in chat or git):
```
MONGODB_URI=            # Atlas connection string (app user, readWrite on the app DB only)
GEMINI_API_KEY=
GEMINI_MODEL=           # gemini-3.5-flash-lite (dev + free demo); gemini-3.8-flash from Stage 8
AI_ENABLED=true
AI_DAILY_CALL_BUDGET=400
CORS_ORIGINS=           # optional extra origins
TRUST_PROXY_HOPS=       # 3 on Render, unset locally
CONTACT_EMAIL=          # used in the User-Agent for Chess.com/Lichess
MAX_GAMES_PER_PLAYER=200
DEMO_PLAYERS=           # e.g. chesscom:myname,lichess:somename (never evicted)
PORT=5000
```
**web/.env.local**: `NEXT_PUBLIC_API_URL=`

---

## 15. Build order (every stage ends in something I can run and show)

Deploy at the end of **Stage 0** and keep deploying after every stage. That way, platform problems (CORS, proxy hops, sleeping servers, changed addresses) show up early, not on demo day.

| Stage | Build | Demo at the end | Done when |
|---|---|---|---|
| **0. Scaffold + deploy** | Monorepo, Express app with health route, env validation, error handler, CORS, trust proxy, Mongo connection; Next.js skeleton with the palette and type; MongoDB MCP server (read-only) | Live site shows "API ok · DB ok" | Deployed on Vercel + Render; `/api/health` live; tests pass |
| **1. Import + queue** ✅ done 31 Oct 2026 | Job queue (leases, retries, idempotency), Chess.com + Lichess importers, SSE progress, games list with cursor pagination | Type a username, watch games stream in live | Re-import doesn't duplicate; killing the server mid-import resumes after restart; 429 handled |
| **2. Engine + game review** | Stockfish worker pool, claim/results API, classification, board + eval graph + move list | "Here are your blunders" on real games | Closed tab loses no work; measured seconds per game written in the README |
| **3. Patterns dashboard** | Feature extraction, aggregation pipelines, Blunderprint ribbons + heat board, filters | The dashboard with the signature visual | `.explain()` shows index use for the main queries |
| **4. The big dataset** | `import-positions` script, positionStats + openings, "players at your level play…" panel, storage guard | Your move vs. millions of games | Size report inside budget; storage guard evicts correctly in a test |
| **5. Coach agent** | Tools, loop, verifier, structured output, live trace over SSE, caching | "Coach me" end to end | Verifier tests: a fabricated stat or evidence is caught and repaired or dropped |
| **6. Ask + guards** | Follow-up questions, per-IP limits, global AI budget, kill switch, demo players pre-analysed | Recruiter can ask follow-ups safely | Budget exhaustion shows the friendly message; demo players never evicted |
| **7. Landing + animation pass** | Landing page, motion polish everywhere, reduced-motion support | The full 60-second demo | Smooth on my laptop with dev tools closed |
| **8. Hardening + README** | Tests for all core logic, structured logs, README (architecture, decisions, numbers, demo GIF), then the one-off AI credit with a spending cap (done through the Claude.ai chat) | Portfolio-ready | Everything in section 16 has a fallback in place |

---

## 16. Risk list

| Risk | Likelihood | Effect | Fallback |
|---|---|---|---|
| Browser engine too slow for 200 games | High | Long waits in the demo | Analyse the newest 50 first; node budget; start the coach once ≥ 20 games are analysed; demo players pre-analysed; reuse Lichess evals |
| positionStats doesn't fit in 512 MB | Medium | Atlas refuses writes | Fewer plies (12), higher `MIN_POSITION_GAMES`, fewer bands, fewer shards. Last resort: Atlas Flex (pay per use) |
| Gemini model renamed or deprecated, or free limits too low | Medium | Agent breaks | Model name from env; friendly error; cached reports; one-off credit at Stage 8 |
| Agent invents stats or positions | Medium | Credibility loss | Code verifier, repair round, drop unverifiable claims, show the evidence boards |
| Chess.com blocks or 429s us | Low–Medium | Imports fail | Strictly serial requests, User-Agent with contact, ETag caching, clear user message |
| Parquet schema differs or parsing is slow on 8 GB | Medium | Stage 4 delay | Inspect the schema first, stream in chunks, one shard at a time, run with dev servers stopped |
| Render sleeps mid-job | Certain | Jobs pause | By design: leases expire and the jobs resume on wake |
| Abuse (someone imports thousands of users) | Low | Storage and quota drain | Per-IP limits, storage guard, max games per player |
| GPL-3.0 engine code in the repo | Certain | Licence obligation | Keep the repo public, ship Stockfish's licence file, credit it in the README. Not legal advice: keep it simple and open |
| Scope creep (accounts, puzzles, multiplayer…) | High | Never finished | Out of scope until Stage 8 is done (section 18) |

---

## 17. Known gotchas

- **Gemini model names** get deprecated faster than published dates suggest. `gemini-3.5-flash` was retired on 8 Oct 2026. Keep the model in env and verify it before Stage 5. Don't confuse the retired `gemini-3.5-flash` with `gemini-3.5-flash-lite` (current; no shutdown date announced as of 30 Oct 2026). `gemini-3.1-flash-lite` shuts down on 7 May 2027.
- Next 16: check node_modules/next/dist/docs/ for version-matched API docs before using Next APIs.
- **Stockfish:** use the *lite single-threaded* build. The multi-threaded builds need `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, which would also break other things on the page. Serve `.wasm` with the `application/wasm` MIME type, from `web/public/engine/`.
- **Chess.com:** serial requests only; 12–24 h data delay; skip variants; don't copy their visual assets.
- **Lichess:** one request at a time globally; wait 60 s on 429; verify parameter names in the official docs.
- **Ratings differ between sites.** Bands are approximate for Chess.com players. Label them so.
- **FEN normalization:** drop the move counters, and keep the en-passant square only when a capture is legal. Test it.
- **Atlas M0:** 512 MB storage; network access must allow Render. Render's free outbound addresses aren't fixed, so we use `0.0.0.0/0` with a strong password and a least-privilege DB user. No automated backups.
- **Render free:** sleeps after 15 minutes; the first request takes up to about a minute; no free background workers (so the queue runs in the API process).
- **Render builds with `NODE_ENV=production`,** so a plain `npm ci` skips devDependencies (TypeScript, build tools). The build command must be `npm ci --include=dev && npm run build`. Footnote needed exactly this.
- **Render env vars are changed by me in the dashboard,** never by a tool call. A bulk update can replace all of them.
- **TRUST_PROXY_HOPS must be 3 on Render.** Too low and everyone shares one rate-limit counter; too high and visitors can fake their address.
- **CORS:** the Vercel URL must be in the allowlist, including for EventSource (SSE).
- **Windows:** CRLF line endings make diffs noisy (`--ignore-cr-at-eol`); commands must work in cmd; watch the RAM during the import.
- **cmd QuickEdit freezes the API:** clicking inside the cmd window running the API selects text and pauses the process (logs, requests and the job all stop until you press a key). Disable it: cmd window → Properties → Options → untick "QuickEdit Mode".
- **Render's free CPU is ~15–20× slower than my laptop** (measured: chess.js replay 8 ms vs 110–160 ms a game; the text ply count 0.1 ms vs ~2 ms). Anything CPU-heavy in a request or job must be measured on Render, not just locally.
- **Atlas writes from my home connection can be 10× slower than from Render** (import batches: 6–44 s from the laptop on 31 Oct vs 0.9–2.5 s from Render, both to the Singapore cluster). Time database-heavy work on Render, not locally.
- **Never commit `.claude/`.**

---

## 18. Scope guard (not in v1)

Accounts or sign-in, saving favourites, puzzles generated from mistakes, multiplayer, live games, mobile app, multiple languages. Each is a good "next" idea for the README's roadmap, after Stage 8.
