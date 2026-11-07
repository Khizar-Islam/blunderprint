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
  ├─ Coach agent: Gemini (Interactions API) ↔ tools (read-only Mongo queries), own worker lane
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
| AI | Google Gemini, **Interactions API** (`POST /v1beta/interactions`, `store: false`) called with plain `fetch` (`agent/gemini.ts`), not the `@google/genai` SDK: the SDK's automatic continuation can send several billed requests per call, its errors lose Google's retry delay, and it retries on its own | Model from env `GEMINI_MODEL`. **Dev and the free demo use `gemini-3.5-flash-lite`:** on the free tier it gets 500 requests/day (15 RPM, 250K TPM; checked in AI Studio 4 Nov 2026), while `gemini-3.8-flash` gets only 20/day. Switch to `gemini-3.8-flash` at Stage 8 with the paid credit. Function calling and structured output verified for `gemini-3.5-flash-lite` on 4 Nov 2026 (tools + structured output in one request is Preview only, so the loop uses two phases, §10). |
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
│  │  │                       errors.ts, setup.ts, handlers/ import.ts + extract.ts)
│  │  ├─ importers/          (chesscom.ts, lichess.ts, politeFetch.ts, normalize.ts)
│  │  ├─ chess/              (fen.ts normalize, classify.ts win%, phase.ts Lichess Divider port,
│  │  │                       features.ts per-game features; openings.ts in Stage 4)
│  │  ├─ stats/summary.ts    (the dashboard's one $facet pipeline + response shape, SUMMARY_VERSION)
│  │  ├─ agent/              (tools/*.ts incl. candidates.ts, loop.ts, verifier.ts, prompts.ts, schema.ts,
│  │  │                       model.ts + gemini.ts + scriptedModel.ts (dev), pacer.ts, context.ts,
│  │  │                       coach.ts runtime, budget.ts kill switch + daily budget, friendly.ts error codes,
│  │  │                       basis.ts analysedGamesHash, reportStore.ts, runs.ts run store + event bus,
│  │  │                       runExpiry.ts which runs the TTL may delete)
│  │  ├─ routes/             (players, games, jobs (SSE stream), analysis, summary, positions,
│  │  │                       coach (GET/POST report), runs (SSE stream), health)
│  │  ├─ middleware/         (requestId.ts, errorHandler.ts, rateLimit.ts, budget.ts)
│  │  └─ lib/                (logger.ts, sse.ts helpers, cursor.ts pagination cursors,
│  │                          validate.ts zod → 400, sleep.ts, version.ts, explain.ts explain summaries,
│  │                          demo.ts frozen demo players)
│  ├─ scripts/               (test helpers: testDb, testServer, fakeFetch, fixtures, sseClient;
│  │                          importOnce, explainGames, explainSummary, extractFeatures (backfill),
│  │                          fetchDivisionFixture; coach: coachTools, coachCli, coachFixture, fakeModel;
│  │                          one-off fixes: backfillClassifications, fixUndefinedOpenings)
│  └─ .env.example
├─ docs/explain/             (saved .explain() output for the README)
├─ web/
│  ├─ src/app/               (/, /p/[platform]/[username], /p/.../game/[id] (?ply=N), /p/.../coach;
│  │                          /dev/engine: engine timing lab used for the Stage 2 measurements, dev only (404 in production))
│  ├─ src/lib/               (api.ts, useJobStream.ts, useWakingRequest.ts, format.ts,
│  │                          ribbon.ts, timeline.ts replay + SAN, winPercent.ts graph + accuracy,
│  │                          filters.ts URL ⇄ filters, useSummary.ts + refetch.ts, plyParam.ts,
│  │                          coach.ts button state + stat/facts text, runStream.ts + useRunStream.ts,
│  │                          useCoachInfo.ts; Stage 7: useReveal.ts + stagger.ts, useIndicator.ts,
│  │                          dashboardStart.ts + summaryPrefetch.ts, mountQueue.ts + useMountWhenNear.ts,
│  │                          perfProbe.ts + perfStats.ts (?perf=1))
│  ├─ src/components/        (PlayerSearch, PlayerDashboard, ImportProgress, GamesList, HealthStatus,
│  │                          MotionProvider, AnalysisBar;
│  │                          review/: GameReview, Board, EvalGraph, MoveList, BetterMove, classes;
│  │                          patterns/: PatternsDashboard, Filters, Blunderprint (canvas) + geometry.ts,
│  │                          HeatBoard + heat.ts, OpeningsTable, charts/ (StackedBars, AnimatedNumber,
│  │                          scale.ts, sample.ts);
│  │                          coach/: CoachButton, CoachPage, AgentTrace, PatternCard, StatLine,
│  │                          EvidenceBoard, FingerprintLens + lens.ts;
│  │                          landing/: HeroPrint (canvas) + heroTimeline.ts, demoData.ts)
│  ├─ src/data/demo.json     (committed landing snapshot of the frozen demo player)
│  ├─ src/engine/            (stockfish.ts worker wrapper, uci.ts parsing, analyseGame.ts,
│  │                          replay.ts, scheduler.ts claim/analyse/post + Web Lock,
│  │                          useAnalysis.ts React hook, throughput.ts s/game)
│  ├─ scripts/copy-engine.mjs (predev/prebuild: copies the engine from node_modules/stockfish)
│  ├─ scripts/snapshot-demo.mjs (by hand, npm run snapshot:demo: live API → src/data/demo.json)
│  ├─ scripts/ui-*.mjs       (Stage 7 checks over headless Chrome, run comments at the top of each:
│  │                          ui-audit hover/press/focus, ui-motion reduced motion + no frames + 390 px,
│  │                          ui-cls layout shift, ui-frames long frames, ui-labels, ui-shots)
│  ├─ public/engine/         (gitignored, copied at build: stockfish-19-lite-single.js + .wasm,
│  │                          Copying.txt GPL text, SOURCE.txt where the source is)
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
  summary, summaryVersion, // the cached UNFILTERED dashboard summary (stats/summary.ts), rebuilt by the
                          // extract and import jobs; another SUMMARY_VERSION is ignored and rebuilt
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
    status: "pending"|"claimed"|"done"|"imported"|"unanalysable",  // imported = came with Lichess evals;
                                                    // unanalysable = the browser couldn't replay the PGN
    claimedBy?, claimExpiresAt?, engine: "sf19-lite", depthOrNodes,
    evals: [ { cp?: number, mate?: number } ],      // per ply, from White's view; { mate: 0 } = side to move is mated
    best?: [ uci|null ],                            // engine's best move before each ply (Lichess: judged plies only)
    classifications: [ "best"|"good"|"inaccuracy"|"mistake"|"blunder" ],
    accuracy?,                                      // average move accuracy of the imported player
    durationMs?, analysedAt?, error?: { code: "illegal_pgn"|"ply_mismatch", atPly? } }
  features: {                // written by the extract job (8.3); absent until then
    version,                 // FEATURES_VERSION: a game with another version is extracted again
    error?,                  // the PGN didn't replay: skipped until the next version
    division: { middle?, end? },  // plies where those phases start (Lichess's Divider)
    mistakes: [ { ply, kind, phase, san, best?, winDrop, clockLeft?, timeTrouble?,
                  square,     // the move's destination square
                  pieceLost?, // "p"|"n"|"b"|"r"|"q": lost within 2 plies
                  fen } ],    // normalized, BEFORE the move
    moveCounts: { opening, middlegame, endgame, clock?: { over50, from25to50, from10to25, under10 } } } }
                             // the player's moves per phase / clock bucket: per-100-moves denominators
```
Indexes:
- unique `{ playerId, sourceId }` (idempotent import). Keyed by player, not `{ platform, sourceId }`: if two players we track played each other, the game is stored once per player, because `color` and `result` are per player. With `{ platform, sourceId }` the second import would overwrite the first player's copy.
- `{ playerId, playedAt: -1, _id: -1 }` (cursor pagination). `_id` breaks ties between games with the same `playedAt`, so the index alone gives the full sort order (no in-memory sort).
- `{ playerId, "analysis.status": 1 }` (work claiming); `{ playerId, "opening.eco": 1 }`.
Keep only the **most recent N games per player** (env `MAX_GAMES_PER_PLAYER`, default 200).

### jobs (the queue)
```
{ _id, type: "import"|"extract"|"report", key (idempotency key, e.g. "import:chesscom:hikaru", "extract:<playerId>",
                                                "report:<model>:<playerId>"),
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
reports: { playerId, analysedGamesHash, promptVersion, model, runId, outcome: "patterns"|"none",
           patterns: [ verified pattern + per evidence: fen, played/betterMove (SAN) + playedUci/betterUci,
                       color, moveNumber, kind, winPctLost, facts { speed, phase, clockBucket,
                       clockLeftSeconds, opening } ],
           answeredBy (the fallback, if the run switched), analysedGames, usage, durationMs,
           dropped, trimmed (logs/README only, never sent) }
agentRuns: { playerId, kind: "report", jobId, status: "queued"|"running"|"done"|"failed", rev, attempt,
             model, promptVersion, analysedGamesHash, steps: [ TraceStep ] (≤ 60), usage, reportId?,
             error?: { code, message } (always the friendly pair), startedAt, finishedAt }
```
- `analysedGamesHash` (`agent/basis.ts`): SHA-1 of `FEATURES_VERSION` + the sorted ids of the player's analysed games with current features. Taken when a run **starts**, so games analysed during a run make the report stale instead of mislabelled.
- `reports` indexes: unique `{ playerId, analysedGamesHash, promptVersion, model }` (the cache key; the model is part of it) and `{ playerId, model, createdAt: -1 }` (latest report). Only the **newest report per player and model** is kept: older ones are deleted after the new one is saved. Per model, so a local scripted run never deletes a real report.
- Each evidence item also stores its game's move `ribbon` (the coach page's fingerprint lens). Reports saved before that (Stage 5 chunk D) get their ribbons filled on first read: one query, saved back without touching `updatedAt`, no AI call (`withRibbons`).
- `agentRuns`: TTL index on `expiresAt` (`expireAfterSeconds: 0`, Stage 7; it replaced a 14-day TTL on `createdAt`). Every run is created with `expiresAt` = created + 14 days; only the run behind a **demo player's current report** has none, so the demo's "How this report was made" never expires. `agent/runExpiry.ts` `syncRunExpiry` keeps those runs and dates every other run without one (createdAt + 14 days), at startup and after each saved report.

### usage (limits and AI budget)
`{ _id: "<scope>|<yyyy-mm-dd>", count, expiresAt }`. The date is a **Pacific-time** day (Google's daily quota resets at midnight Pacific). Scopes: `global:ai` (real model calls), `dev:scripted` (the local scripted model, so dev runs never use the real budget), and `ip:<hash>` in Stage 6 (hash the IP, don't store it raw). TTL index on `expiresAt` (3 days after the day ends).

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
5. Update `players.importState`. If analysed games lack features (e.g. Lichess games that came with evals), enqueue the player's `extract` job. Then rebuild the cached summary (new games and trimmed old ones change the totals and openings).
6. Errors: on 404 the user doesn't exist (fail cleanly); on 429 back off (Lichess: 60 s); network errors retry with exponential backoff up to `maxAttempts`.

### 8.2 Browser engine analysis
1. The web app asks `POST /api/analysis/claim { platform, username, prefer? }` (POST, not GET: it changes data, and a GET can be prefetched or retried by the browser) and receives up to K pending games (K=3), newest first, with `prefer` first. The server marks them `claimed` by a random claim token with a 10-minute `claimExpiresAt`. The game review page claims with `prefer` = its own game and runs **one** engine, and stops once that game is stored.
2. The engine runs in Web Workers: **2 on machines with 4+ cores** (`navigator.hardwareConcurrency`), 1 otherwise. It evaluates the position after every ply with a fixed **100,000 nodes**, not unbounded depth or a time limit, so the time per game is predictable and the result doesn't depend on the machine (measured 1 Nov 2026: ~150 ms per position on 1 engine; with 2 engines roughly one 111-ply game every 10 s; table in the README).
   - **One tab at a time:** `scheduler.ts` takes the Web Lock `blunderprint:engine` (`navigator.locks`, shared by every tab of the site). A second tab shows "another Blunderprint tab is analysing" and takes over by itself when the first closes or pauses.
   - **Start:** desktop (fine pointer, ≥ 640 px) starts by itself, with Pause/Resume. Phones wait for an **"Analyse on this device"** button, because the engine drains the battery.
   - **Progress:** the bar shows "N of M analysed" and an effective **"~N s per game"** (analysing time ÷ games finished, both engines together, so it matches how fast the list fills). Ribbons fill tick by tick as plies are evaluated.
3. It posts `POST /api/analysis/results` with per-ply evals, best moves and played moves (UCI). The server validates the counts against the stored plies, the bounds, and that the game is still claimed by this token (a reclaim changes the token, so a late result from an old tab gets 409; a repeat from the same claim gets 200). It then classifies the moves, stores the result and enqueues the player's `extract` job. If chess.js can't replay the PGN (or replays a different number of plies), the browser reports `illegal_pgn`/`ply_mismatch` and the game becomes `unanalysable`.
4. Expired claims are claimable again, so a closed tab never loses work. Anyone viewing the player later continues the analysis. On `pagehide` the browser also sends `POST /api/analysis/release` with `navigator.sendBeacon` (a text/plain body, parsed by the route's own `express.text`) so its unfinished games go back at once.
5. **Classification** (`chess/classify.ts`, ported from lila's `Advice.scala` and scalachess's `WinPercent`, with sources cited there): win chances `2/(1+e^(−0.00368208·cp))−1`; a drop of ≥ 0.1 / 0.2 / 0.3 is an inaccuracy / mistake / blunder; mate transitions follow lila's `MateAdvice`; ply 1 is judged against +15 cp; the engine's own best move is `best` and never judged. Imported Lichess games keep **Lichess's own judgements** (it skips moves that were the engine's best, which its export doesn't fully name). On 276 real games our formula matched all 3,212 of Lichess's judgements and added 65 extras.

### 8.3 Feature extraction (job `extract`) and the summary
- **One `extract` job per player** (key `extract:<playerId>`; there is no separate `aggregate` job). Every "there may be new work" signal enqueues it: a stored engine result, an import that brought analysed games, and the summary route's backstop. The unique key means one queued-or-running job, however many signals. The handler **drains**: batches of 20 games whose `features.version` is missing or old, until none are left, yielding to the event loop every ~50 ms. At the end it rebuilds the cached summary.
- **Per game** (`chess/features.ts`, only the imported player's moves):
  - Phase: a port of Lichess's `Divider` (`chess/phase.ts`); it matched Lichess's own `division` on **200/200** real games.
  - Each mistake gets: kind, phase, the move (SAN) and the better move when known, the win% drop, clock left (time trouble below 10% of the starting time), the destination square, any piece lost within 2 plies, and the normalized FEN before the move.
  - `moveCounts`: the player's moves per phase and clock bucket, so rates are per 100 moves, not just per game (otherwise the endgame looks safe because many games never reach one).
  - Openings: grouped by the platform's ECO code for now; matching positions against `openings.epd` comes with Stage 4.
  - **Measured on Render** (EricRosen, 145 games in 28 s): ~302 ms a game for the first (cold) batch, then **135–220 ms a game** warm, including the Atlas write.
- **Per player** (`stats/summary.ts`): ONE pipeline. `$match` (player + filters) → `$sort` in the index order → `$project` (no PGN or evals) → `$facet` with totals, openings by ECO, the move-count denominators, errors by phase, speed, clock bucket (a `$switch` so the edges match `clockBucket()` exactly) and move number, errors per square split by colour, and one ribbon per analysed game (classifications as one letter per ply).
  - **Unfiltered**, it's cached in `players.summary` (with `SUMMARY_VERSION`, now 2). A rebuild only writes if no newer summary is stored, and `generatedAt` is stamped **before** the read, so a slow rebuild of older data never wins.
  - **Filtered** (colour, speed, from/to), it runs live per request: at most 200 games.
  - `.explain()` (saved in `docs/explain/`): both use an IXSCAN on `{ playerId, playedAt, _id }`, with no COLLSCAN and no in-memory SORT (unfiltered 200 keys / 200 docs; filtered 91 / 91).
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

**The design in one paragraph:** code finds the weaknesses, the model picks and explains them, and code checks every claim. `get_weakness_candidates` computes the candidate groups and their numbers; the model investigates with read-only tools (phase 1), then answers in a fixed JSON shape with no numbers or titles of its own (phase 2); the verifier copies the figures from the candidate, checks the evidence and the prose, asks for one repair round, and trims or drops what still fails. Google's overloads are retried with backoff and, after two in a row, the rest of the run switches to a fallback model.

### Tools (read-only, return **compact aggregated JSON**, never raw game dumps; ≤ ~2k tokens each)

| Tool | Purpose |
|---|---|
| `get_player_profile()` | Ratings, games analysed, results by colour and speed, accuracy, errors per 100 moves and per game (overall and per kind) |
| `get_weakness_candidates()` | **Code finds the weaknesses:** every group (phase, clock bucket, move numbers, speed, colour, opening, phase × clock) at least `COACH_MIN_BASELINE_GAP` worse than the player's own figure, on ≥ `COACH_MIN_CANDIDATE_GAMES` games / ≥ `COACH_MIN_CANDIDATE_MOVES` moves, with errors in ≥ 2 games. Up to 12, ranked by a z-score, each with an id, label, value vs baseline, sample, `parentIds` and the `exampleFilter` |
| `get_opening_breakdown({ color?, speed?, minGames })` | Per opening: games, score %, mistakes per game |
| `get_mistake_breakdown({ groupBy, filters })` | groupBy: phase, speed, clockBucket, moveNumberBucket, pieceLost, square |
| `find_example_mistakes({ filters, limit ≤ 5 })` | Matching errors/games + examples `{ gameId, ply, moveNumber, fen, played, betterMove, winPctLost, clockLeftSeconds, clockBucket, phase, speed, opening }` |
| `get_position_stats({ fen, band })` | What players in a band play from this position (positionStats). **Hidden from the model until Stage 4** (stub + test exist) |
| `get_game_summary({ gameId })` | Opening, result, key moments |

All tools take the player from the server context, never from the model, so the model can't query other players. Arguments are strict (an unknown key is a readable error, not silently dropped). Tool results leave out opponent names and other outside free text, and the system prompt says tool results are data, never instructions (prompt-injection defence, tested with an injected opening name).

### Loop (`agent/loop.ts`)
1. A system prompt (`PROMPT_VERSION`, now 6) sets the job: choose 3–5 **recurring** patterns from the code-found candidates and explain them, with evidence from that candidate's examples. Say "not enough data" instead of guessing.
2. **Two phases** (only stable features; tools + structured output in one request is Preview and timed out in the first real run):
   - **Investigate:** tools only. Run the tool calls, append the results (each carries its step number), repeat until the model is done.
   - **Answer:** one call with structured output and no tools; one format retry if the JSON can't be read.
   - Hard limits: **10 model calls** (`COACH_MAX_MODEL_CALLS`, two kept back for the answer) + **2 repair calls**, 120K tokens, **60 s per call**, **300 s per run**. These count logical calls; every real request, retries included, counts against **`COACH_MAX_REQUESTS` (16) per run**, and the investigation stops early rather than use the last 4 (the answer call + its retries), so a stormy investigation can't starve the answer.
   - Retries: a 429 waits (Google's delay when given, up to 3 times). **Overloaded** (503 "high demand", or a 5xx saying UNAVAILABLE/overloaded): up to **3 retries** waiting ~2 s, 6 s, 15 s (±20% jitter); after **2 in a row** on one call the rest of the run switches to **`GEMINI_FALLBACK_MODEL`** (`gemini-3.1-flash-lite`: Stable, function calling + structured outputs; shuts down 7 May 2027). A timeout / network / other 5xx gets one more try. Every request counts in the daily budget, and every model error is logged with its phase (investigate / answer / repair).
   - Why: on 5 Nov 2026 both live runs on Render failed on Google's 503 "currently experiencing high demand" (the answer call failed twice in a row). A probe of the answer-shaped request (full schema, no tools) completed in 1.9 s, so the schema wasn't the cause (`npm run coach:probe`).
   - **Rate limit:** one process-wide pacer (`agent/pacer.ts`): calls ≥ 60 000 / `GEMINI_RPM` ms apart (4 s at 15 RPM) and under `GEMINI_TPM` in any 60 s.
3. The answer's schema: `patterns: [ { candidateId, explanation, evidenceStep, evidence: [ { gameId, ply } ], drill } ]`. The model writes **no number and no title**: the verifier copies the statistic, baseline, direction and label from the candidate ("7.9 vs your 3.1").
4. **Verifier (code, not AI):**
   - The candidate must have come back from `get_weakness_candidates` in this run.
   - `evidenceStep` must be a `find_example_mistakes` step whose filters EQUAL the candidate's `exampleFilter`; every evidence item must be one of its examples, from ≥ 2 distinct games; no position in two patterns; no two patterns whose groups overlap.
   - Prose: digits only from named fields (candidate figures, matching counts, each evidence item's move number / win% lost / clock, bucket bounds); no number words; SAN moves only the pattern's own played/better moves; explanation ≥ 2 sentences and 120 characters, drill ≥ 60.
   - On failure, **one repair round** that tells the model what failed. Then whatever still fails is trimmed (bad evidence, if ≥ 2 games remain; unbacked sentences) or the pattern is dropped.
5. Stream every step to the UI over SSE: the kind (model / tool / verify / repair / retry), a short label, a short detail and the time taken. That's the live "agent trace".
6. **Cache** reports by `(playerId, analysedGamesHash, PROMPT_VERSION, model)`, where `model` is the one asked for; a report written by the fallback records it in `answeredBy`. If nothing changed, POST returns the cached report instantly with no AI calls.

### The report job (`jobs/handlers/report.ts`)
- Key `report:<model>:<playerId>`: asking twice returns the same run. `maxAttempts` 2.
- Runs on its **own worker lane** (a second worker that only claims `report` jobs for this process's model), so a report spending a minute on the AI never holds up imports. One report at a time: the pacer is shared anyway.
- A failed run (time limit, model error, no answer) is final, never retried: a retry would spend the calls again. Only errors outside the run (the DB) retry.
- Shutdown mid-run: the run goes back to `queued`, the job is released (attempt refunded), and the next process starts the run **from scratch** (the conversation lived in memory; the calls already made are lost). A hard kill: the reaper requeues; out of attempts → `coach_interrupted`.

### Friendly errors (`agent/friendly.ts`)
Every failure a visitor can see is a fixed `{ code, message }`; the real error only goes to the logs. Codes: `player_not_found`, `not_enough_games`, `ai_disabled`, `ai_budget_exhausted`, `ai_busy` (429s), `ai_unavailable` (timeout / 5xx / network), `coach_timeout`, `coach_too_long` (token/call limit), `coach_no_answer`, `coach_interrupted`, `coach_config` (400/auth: our side), `run_not_found`, `internal`. A run with no surviving pattern shows a fixed "no weakness clearly stood out" message; the model's own `notEnoughData` text is only logged.

### "Ask the coach" (Stage 6)
Follow-up questions use the same tools, capped at 6 steps, with the same evidence rules.

### Guards
- Per-IP limits (hashed IP, Stage 6): e.g. 5 imports/hour, 3 reports/day, 20 questions/day.
- Global daily AI call budget (`AI_DAILY_CALL_BUDGET`, default 400, under the 500/day free limit, Pacific-time days) and a kill switch (`AI_ENABLED=false`) that shows a friendly message (built in Stage 5, `agent/budget.ts`):
  - Checked before a run starts (POST refuses below one worst-case run: `COACH_MAX_REQUESTS` = 16 requests) AND before every model request, retries and fallback included (`guardedModel`).
  - One atomic `findOneAndUpdate` with upsert per request: `{ _id: day, count < budget } → $inc 1`. A duplicate-key error (11000) is retried **once**: at the start of a day two first inserts can race, and only a second miss really means the budget is used up.
- Free-tier note: on the free tier Google may use prompts to improve its models. That's fine here, because all the data is public games.
- When the budget runs out, show cached reports and an honest message. Never show a raw error.

---

## 11. API routes

```
GET  /api/health                                   → { ok, db, queueDepth, version }
POST /api/players/:platform/:username/import       → 202 { jobId } or 200 { upToDate: true } (idempotent: returns the running job)
GET  /api/players/:platform/:username              → { player, activeJob } (player: profile + importState + counts; no summary)
GET  /api/players/:platform/:username/summary      → { summary, cached, extracting } (?color=&speed=&from=&to=)
GET  /api/players/:platform/:username/games        → cursor pagination (?cursor=&limit=&speed=&color=&result=)
GET  /api/games/:id                                → game + analysis + features
POST /api/analysis/claim                           → { claimId, expiresAt, games } up to K games to analyse (leases); a demo player: games [] + frozen: true
POST /api/analysis/results                         → evals for one claimed game (validated, idempotent)
POST /api/analysis/release                         → hand unfinished claimed games back (sendBeacon, text/plain)
GET  /api/positions/stats?fen=&band=               → positionStats lookup
GET  /api/players/:platform/:username/report       → { report, stale, staleReason ("new_games"|"new_version"|null), newGames, eligibility: { analysed, needed, ok }, activeRun, ai: { enabled, budgetLeft, canStart } }
POST /api/players/:platform/:username/report       → 202 { runId } / 200 { report, cached: true } / 404 / 409 / 503 / 429 (see below)
POST /api/players/:platform/:username/ask          → { runId } (Stage 6)
GET  /api/jobs/:id/stream                          → SSE: job progress
GET  /api/runs/:id/stream                          → SSE: agent steps, then the final result
```
- **POST report** checks, in order: no player → 404 `player_not_found`; a run already going → 202 the same `runId`; a report for exactly this data → 200 cached (no AI call, even with AI off); fewer than `COACH_MIN_ANALYSED_GAMES` (20) → 409 `not_enough_games`; AI off or no model → 503 `ai_disabled`; budget under one worst-case run (16 requests) → 429 `ai_budget_exhausted` + `Retry-After` (seconds to Pacific midnight); else 202 `{ runId }`. Error bodies are `{ error, code }`.
- **Run SSE contract** (`GET /api/runs/:id/stream`): the same as the job stream (subscribe → snapshot → only newer revs, `retry: 3000`, 15 s heartbeat, ends after `done`/`failed`, a reconnect starts with a snapshot). Events: `snapshot`, `status`, `done`, `failed` carry the whole public run (`done` and a finished snapshot include the report); `step` carries only `{ step }`.

Rules:
- Validate every input with zod.
- **Cursor pagination,** not skip/limit.
- The SSE endpoints send a heartbeat comment every 15 s and close cleanly.
- **CORS also applies to EventSource,** so the allowlist must include the Vercel site.
- **POST import:** 202 `{ jobId }` starts (or rejoins) an import. 200 `{ upToDate: true }` when the last successful import is under **6 h** old and none is active (Chess.com only refreshes every 12–24 h anyway). Repeating the call is safe: while an import is queued or running, the same job comes back.
- **Demo players** (`DEMO_PLAYERS`, `lib/demo.ts`) are **frozen** so a visit can never change the demo: once imported, POST import is 200 `{ upToDate: true, frozen: true }` however old the import (their first import still runs, to seed them); the claim hands out no games; GET player and GET game carry `demo: true`, and the UI shows "Demo player · games as of <date>" with no analysis bar (the review page doesn't start the engine). Their data is completed by hand (all games analysed, a fresh report) before they are added.
- **GET summary:** no filters → the cached `players.summary` (built and stored on the first view of a version); any filter → computed live. Filters are strict: unknown keys are 400; `from` is inclusive and `to` exclusive, each a date or a full ISO timestamp.
  - `extracting: true` while analysed games lack features **or** the player's extract job is queued or running (the cached summary is only rebuilt at the end of that job). The dashboard keeps refetching while it's true.
  - **Backstop:** a GET that finds games without features enqueues the extract job, on purpose (the unique key makes repeats free).
  - **Measured on Render** (from the browser): cached 110–117 ms, filtered (White + bullet) 128–136 ms. Render's edge serves Brotli: 46 KB of JSON → 7.1 KB on the wire, so there's no Express compression middleware (it would also buffer the SSE streams).
- **GET player:** `{ player, activeJob }`. `player` is null while a first import is still queued (the job creates the player once the platform confirms they exist); `activeJob` lets a reloaded page reattach to the stream. 404 only when there is neither.
- **Job SSE contract** (`GET /api/jobs/:id/stream`):
  - Events: `snapshot`, `progress`, `retrying`, `done`, `failed`. Every event's `data` is the whole public job, and its `id:` is the job's `rev` (a counter bumped on every change).
  - **Subscribe, then snapshot:** the route subscribes to the in-process event bus first, buffers, reads the job and sends it as `snapshot`, then sends only buffered/later events with `rev` greater than the snapshot's. Nothing is lost or duplicated in between.
  - `retry: 3000`, a heartbeat comment every 15 s, and the server ends the stream after `done`/`failed`. A reconnect always starts with a fresh snapshot.
  - A 429 is waited out inside the importer, so it doesn't produce a `retrying` event: the stream just goes quiet (the UI shows a hint after 20 s).

---

## 12. Frontend: pages, design and animation

### Pages
- `/`: landing. A pre-analysed demo player's Blunderprint animating, plus one input: username and platform toggle. **As built (Stage 7 chunk A):**
  - Headline "Your mistakes leave a print.", the search form, and the hero **"the print develops"** (`landing/HeroPrint.tsx`, phases in `heroTimeline.ts`): 200 faint rows arrive (0–0.9 s, counter ticks up), an ink scan line colours the player's moves (1.2–4 s), then three real evidence moves from the demo report get a ring, a hairline leader and a margin note (move, clock, win-chance cost, the pattern's label and code-written number). ~5.7 s, then the notes take turns being highlighted (desktop only). Hover the print to read a game, click to open it; Replay.
  - Data: the committed snapshot `src/data/demo.json` (`npm run snapshot:demo`; it refuses unless the player is a frozen demo player, every game analysed and the report current). Never a live fetch: the hero must not wait on a sleeping Render.
  - Time-based, not frame-counted; timers land the final canvas and every note even with no animation frames; no frames offscreen. Reduced motion: the final print and all notes at once.
  - **Demo path on the first screen:** right under the form, "No account? Explore the demo: Open this Blunderprint · Read the coach report" (most recruiters have no chess account).
  - Layout: text and hero side by side only from 1280 px (narrower, the text column wraps the demo links below the fold); below that the hero sits under the text. The notes stay beside the print while the print keeps ≥ 400 px, else they become a numbered list under it. Rows 1 + 0.5 px below a 480 px box (300 px for 200 games). Phones: full-width 44 px controls. Checked at 390, 768, 1024 and 1280 px (no horizontal overflow).
  - Caption: "Lichess · DrNykterstein · 200 public games, analysed in the browser · as of <date>" and "Not affiliated with the player". The footer's health check is the API prewarm.
- `/p/[platform]/[username]`: dashboard. Import progress, then analysis progress, then the patterns dashboard (built in Stage 3), then the full games list (never filtered), and later a "Coach me" button.
  - **Filters** (colour, speed, played: all time / 30 days / 90 days / 1 year) live in the URL (`?color=&speed=&range=`) and are pushed with `history.pushState`, so links can be shared and the back button steps through them. The URL keeps the preset, the API gets a `from` date.
  - **Data:** `GET /summary`. The last answer stays on screen while a new filter loads, so the charts animate from the old values. Refetches when the engine stores a game or an import finishes, at most every 10 s, and keeps polling while `extracting`; none while the tab is hidden.
  - **Charts:** hand-rolled SVG, stacked by kind, errors per 100 moves (default) or per game. A bar or openings row on fewer than 5 games is greyed out with "few games".
- The game review takes `?ply=N` (clamped to the game), so the Blunderprint can link straight to a move.
- `/p/[platform]/[username]/game/[id]`: game review. Board, eval graph, move list with classifications, and (Stage 4) a "what players at your level play here" panel. Built in Stage 2:
  - The game is fetched in the browser, so the "Waking the server up…" counter works here too. A game that isn't this player's (platform + username) shows "not found".
  - The header shows the result, opponent and the player's **avg move accuracy**.
  - The eval graph draws itself; clicking or dragging across it jumps to that move. The move list scrolls to the current move. Keys: ←/→, Home/End.
  - On an inaccuracy/mistake/blunder: "Nxe5?? was a blunder. Better was Nf3" plus a **Show** control. Show switches the board to the position **before** the move, with a teal arrow for the better move and a muted rust arrow for the move played (not on the position after, where the piece may have moved or been taken). Show works by click (toggles until clicked again or the move changes), press-and-hold (only while held), or holding B.
  - If the game isn't analysed yet, the page analyses it first (see 8.2, `prefer` + one engine).
- `/p/[platform]/[username]/coach`: the agent trace and the report. **As built (Stage 5 chunk D):**
  - **Dashboard button** (`CoachButton`, from GET /report on the patterns' pulse): locked with a live "12 / 20" counter and a 20-step rule; **Coach me** (the only place a first run starts: POST, then the page); "The coach is working → watch it live"; **See your coach report** (with "7 new games since" or "an updated coach is available"); honest notes when the AI is off or resting until midnight Pacific.
  - **The page never starts a run by itself** (a reload or shared link can't spend calls); Refresh (stale report) and Try again (failed run) are clicks. GET /report renders at once ("based on N games · date", and "written by <fallback>" when the run switched), with the waking-server counter.
  - **Live trace** (`AgentTrace`): a scoresheet (numbered mono lines, time column), lines type in, retries muted, the `switch` step in amber; reattaches after a reload (activeRun → SSE snapshot). When finished (or failed) it folds into "Investigated in 47 s · 9 requests · 3 patterns verified"; an older report's trace opens on demand ("How this report was made", one request; expired after 14 days).
  - **Pattern card**: label, the **fingerprint lens** (the evidence games' Blunderprint ribbons, evidence moves ringed; hover links row ⇄ board), the big "16.2 vs your 11.9" with two comparison bars and the sample, the explanation, the drill as an "Exercise", and 2-4 **evidence boards**: fade in at the position before the mistake → the played piece slides along a muted rust arrow and holds ~0.6 s → slides back → a teal arrow draws the better move; the facts from code under each board and a link to `/game/[id]?ply=N`. Arrows are our own SVG overlay (react-chessboard's arrows can't animate).
  - Reduced motion: the final state at once (position + both arrows, full lens, final numbers, whole trace lines).

### Design direction (no "AI slop")
- **Avoid:** purple-to-blue gradients, glowing borders, glassmorphism, blurred orbs, icon-in-circle feature blocks. Also don't copy Chess.com's green or Lichess's brown boards.
- **Palette (starting point, tell me if you change it):**
  - Ink `#1B1D1A`, Bone `#E9E4D8`, Graphite `#2B2B28`, Stone squares `#D8D2C4` / `#8C8675`.
  - Classifications: inaccuracy Amber `#D4A72C`, mistake Rust `#D9772B`, blunder Brick `#B3362B`, best/good Teal `#3E7C74`.
- **Type:** Newsreader (display serif, the "chess book" feel), Geist (UI), Geist Mono (notation, numbers, the agent trace).
- **Signature visual: the Blunderprint.**
  - Every analysed game is a thin horizontal **move ribbon**, one tick per move, coloured by classification. Only the imported player's moves are coloured; opponent ticks are faint stone.
  - Stacked, the ribbons form a fingerprint-like texture of the player's habits.
  - Beside it sits an 8×8 **heat board** of where mistakes happen.
  - Clicking a tick opens that exact position.
  - **As built (Stage 3):**
    - One **canvas** (200 games × ~80 plies is ~16,000 ticks; as DOM nodes that would be slow). Rows 3 px + 1 px gap (2 + 1 on narrow screens), newest at the top. x is the ply on one scale for all rows, so a column is the same move in every game.
    - Rows are cut at **120 plies** so one long game doesn't squash the rest. A cut row gets an end marker tinted by the worst of the player's errors past the cap. The hover/tap **loupe** draws the game's full row, and its ticks can be clicked too.
    - Keyboard: ↑/↓ choose a game, ←/→ step through its errors (past the cap too), Enter opens.
    - **Heat board:** the destination square of each error. One hue (brick), strength = severity-weighted count (blunder 3, mistake 2, inaccuracy 1) on a scale from 0, so only the costly squares stand out; the label still breaks it down by kind. White's games on a normal board, Black's flipped, "both" with Black's ranks mirrored so rank 1 is always the player's back rank (labels say "from your side").
  - This is the one place to go big visually.

### Animation (generous and purposeful)
- Games drop into the list with a staggered reveal as the import streams in. The counter ticks up.
- Ribbons fill **tick by tick live** as the browser engine analyses. This is the hero moment, so make it feel alive.
- The eval graph draws itself. Dragging across it scrubs the board (tactile).
- Charts re-animate when filters change (colour, speed, date range).
- Agent trace lines type in one by one with the step timings. Pattern cards reveal staggered, and each card's board animates to the critical position.
- Every interactive element gets hover and press feedback.
- Respect `prefers-reduced-motion`.
- **Animated numbers always land** (`AnimatedNumber` + `charts/countTo.ts`, coach and dashboard): a browser that throttles animation frames (background tab, battery saver; a test browser ran 1 frame in 500 ms) left a coach stat at "0.0". A timer writes the final value 150 ms after the count should have ended, frames or not, and a visually hidden copy always carries the final value for screen readers (the counting text is `aria-hidden`).

**As built (Stage 7, done 7 Nov 2026):**
- **CSS first:** the final state is always the element's normal style; keyframes only have a `from` (`bar-x` scaleX bars, `anim-fade`, `anim-rise`, `anim-wipe` in `globals.css`), so a browser with no animation frames still shows the final page. Reduced motion turns all of them off. Route changes fade in (`app/template.tsx`).
- **Moves are transforms, never `top`/`left`:** hover outlines, the Blunderprint loupe, the eval-graph cursor and the sliding segment indicators (`useIndicator.ts`). A moved `top` counts as layout shift (the loupe once measured CLS 0.258); a transform doesn't.
- **Reserved space:** every section that loads holds its height first (patterns placeholder, coach button frame from the first render with a player, two lines for the heat board readout, empty squares for the coach boards), so nothing on screen is pushed.
- **Reveals:** `useReveal` (IntersectionObserver, a page-wide 120 ms stagger queue); coach cards, stats, lens and boards.
- **Heavy mounts take turns:** coach evidence boards mount only within 400 px of the viewport, one per animation frame (`mountQueue.ts`, 100 ms timer fallback).
- **Dashboard start:** the summary is fetched in parallel with GET player, and the patterns, games and coach button render as soon as GET player answers; the import check settles behind them (`dashboardStart.ts`).
- **Every control** has hover, press and focus-visible feedback (checked by `scripts/ui-audit.mjs`: 0 failures on 366 controls). View-only boards are `inert` (no dead tab stops).
- **`?perf=1`** on any page shows the smoothness probe (frame gaps, long animation frames, dropped frames, heap, LCP/CLS, "Copy results"); without it the code isn't downloaded. Results and Lighthouse numbers: README "Performance".

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
  2. Stop the workers (both lanes, in parallel): each aborts its running job, gives the handler **3 s** to wind down, then **releases** the job back to the queue with its attempt refunded, so the next process picks it up at once instead of waiting out the lease. A coach run goes back to `queued` and restarts from scratch.
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
GEMINI_FALLBACK_MODEL=  # gemini-3.1-flash-lite by default ("none" = off): used after 2 overloaded responses in a row
AI_ENABLED=true
AI_DAILY_CALL_BUDGET=400
GEMINI_RPM=15 GEMINI_TPM=250000 GEMINI_RPD=500   # the free-tier limits from AI Studio (pacer + warning)
COACH_MODEL=gemini      # "scripted" = the fake coach for local development (refused in production)
COACH_SCRIPTED_SCENARIO=ok  # dev only: ok | overload-switch | fail-overloaded | slow (refused in production)
COACH_MAX_MODEL_CALLS=10 COACH_MAX_REPAIR_CALLS=2 COACH_MAX_REQUESTS=16 COACH_MAX_TOKENS=120000
COACH_CALL_TIMEOUT_MS=60000 COACH_RUN_TIMEOUT_MS=300000
COACH_MIN_BASELINE_GAP=0.15 COACH_MIN_CANDIDATE_GAMES=5 COACH_MIN_CANDIDATE_MOVES=100
COACH_MIN_ANALYSED_GAMES=20
CORS_ORIGINS=           # optional extra origins
TRUST_PROXY_HOPS=       # 3 on Render, unset locally
CONTACT_EMAIL=          # used in the User-Agent for Chess.com/Lichess
MAX_GAMES_PER_PLAYER=200
DEMO_PLAYERS=           # e.g. lichess:DrNykterstein: frozen (no re-import, no claims), trace kept, never evicted; invalid entry stops startup
PORT=5000
```
**web/.env.local**: `NEXT_PUBLIC_API_URL=`

---

## 15. Build order (every stage ends in something I can run and show)

Deploy at the end of **Stage 0** and keep deploying after every stage. That way, platform problems (CORS, proxy hops, sleeping servers, changed addresses) show up early, not on demo day.

**Order from here (decided 6 Nov 2026):** Stage 7 (landing + animation pass) ✅ done 7 Nov 2026; Stage 6 next, then Stage 4.

| Stage | Build | Demo at the end | Done when |
|---|---|---|---|
| **0. Scaffold + deploy** | Monorepo, Express app with health route, env validation, error handler, CORS, trust proxy, Mongo connection; Next.js skeleton with the palette and type; MongoDB MCP server (read-only) | Live site shows "API ok · DB ok" | Deployed on Vercel + Render; `/api/health` live; tests pass |
| **1. Import + queue** ✅ done 31 Oct 2026 | Job queue (leases, retries, idempotency), Chess.com + Lichess importers, SSE progress, games list with cursor pagination | Type a username, watch games stream in live | Re-import doesn't duplicate; killing the server mid-import resumes after restart; 429 handled |
| **2. Engine + game review** ✅ done 3 Nov 2026 (5e4ec5d, a27157d, 6cba1ad) | Stockfish worker pool, claim/results API, classification, board + eval graph + move list | "Here are your blunders" on real games | Closed tab loses no work; measured seconds per game written in the README |
| **3. Patterns dashboard** ✅ done 3 Nov 2026 (a6ab232, 4417b71, d458f56, 54cf13f) | Feature extraction, aggregation pipelines, Blunderprint ribbons + heat board, filters | The dashboard with the signature visual | `.explain()` shows index use for the main queries |
| **4. The big dataset** ⏸ deferred until after Stage 5 (4 Nov 2026: not enough free disk space on the laptop for the parquet shards). Plan kept: a DuckDB pipeline on the laptop, bullet included, 400-point bands per mover (each move counted in the band of the player who made it), prune locally, publish only the pruned result to Atlas | `import-positions` script, positionStats + openings, "players at your level play…" panel, storage guard | Your move vs. millions of games | Size report inside budget; storage guard evicts correctly in a test |
| **5. Coach agent** ✅ done 6 Nov 2026 (tools d2c510c; loop + verifier 3af51cb, a0e7f4f; API 7286ca4; overload fix cf4d685; coach page 6a065a5; wrap-up docs) | Tools, loop, verifier, structured output, live trace over SSE, caching | "Coach me" end to end | Verifier tests: a fabricated stat or evidence is caught and repaired or dropped |
| **6. Ask + guards** | Follow-up questions, per-IP limits, global AI budget, kill switch, demo players pre-analysed | Recruiter can ask follow-ups safely | Budget exhaustion shows the friendly message; demo players never evicted |
| **7. Landing + animation pass** ✅ done 7 Nov 2026 (frozen demo players 62c9a96, landing 97cf88e, animation pass c721a72, perf probe + parallel summary 2f2456f, perf fixes in the "perf: no layout shift on the dashboard…" commit) | Landing page, motion polish everywhere, reduced-motion support | The full 60-second demo | Smooth on my laptop with dev tools closed |
| **8. Hardening + README** | Tests for all core logic, structured logs, README (architecture, decisions, numbers, demo GIF), then the one-off AI credit with a spending cap (done through the Claude.ai chat). Credits and licences: final check of the Stockfish GPL-3.0 credit (README + `/engine/Copying.txt`, `SOURCE.txt`), **verify the licence of react-chessboard's piece set**, and **decide the repo's own licence** | Portfolio-ready | Everything in section 16 has a fallback in place |

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

- **Gemini model names** get deprecated faster than published dates suggest. `gemini-3.5-flash` was retired on 8 Oct 2026. Keep the model in env and verify it before Stage 5. Don't confuse the retired `gemini-3.5-flash` with `gemini-3.5-flash-lite` (current; no shutdown date announced as of 30 Oct 2026). `gemini-3.1-flash-lite` shuts down on 7 May 2027. Google's Gemini docs moved to aistudio.google.com/docs (the old ai.google.dev/gemini-api/docs pages redirect), and the free-tier limits are no longer published there: read them in AI Studio.
- **Local dev and the shared Atlas DB:** a local API with `COACH_MODEL=scripted` writes reports under model `scripted` and counts its budget under `dev:scripted`, and its coach lane only claims `scripted` report jobs, so it never touches the live coach's reports, budget or jobs.
- Next 16: check node_modules/next/dist/docs/ for version-matched API docs before using Next APIs.
- **Stockfish:** use the *lite single-threaded* build. The multi-threaded builds need `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, which would also break other things on the page. Serve `.wasm` with the `application/wasm` MIME type, from `web/public/engine/`.
- **react-chessboard arrows are SVG attributes,** so arrow colours must be hex (e.g. `#3E7C74`), not CSS variables: `var(--…)` doesn't work in an SVG attribute.
- **The same username on Chess.com and Lichess can be different people.** The platform is part of every URL (`/p/[platform]/[username]`), key and index; never look a player up by username alone.
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
