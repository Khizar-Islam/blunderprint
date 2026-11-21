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
  └─ Guards: rate limits (per IP), AI budget, storage gate + eviction, error handler
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
├─ LICENSE                   (Stage 8 chunk F: the repo's licence, GNU AGPL v3 or later; the official text, unchanged)
├─ THIRD_PARTY_NOTICES.md    (Stage 8 chunk F: every ported, bundled or served work with its licence, where it was read, and its notice)
├─ .github/workflows/ci.yml  (Stage 8 chunk G: on push and pull request to main; backend typecheck + tests,
│                             web typecheck + lint + tests; Node 22, no secrets, read-only token)
├─ backend/
│  ├─ src/
│  │  ├─ app.ts              (createApp(): middleware order, routes, error handler)
│  │  ├─ server.ts           (listen + start worker loop)
│  │  ├─ shutdown.ts         (graceful shutdown order, section 13)
│  │  ├─ config/env.ts       (zod-validated env, parseTrustProxyHops, CORS list)
│  │  ├─ db/                 (mongoose connect, models/*.ts, indexes)
│  │  ├─ jobs/               (queue.ts, worker.ts, events.ts in-process job event bus,
│  │  │                       errors.ts, setup.ts, handlers/ import.ts + extract.ts + report.ts + ask.ts)
│  │  ├─ importers/          (chesscom.ts, lichess.ts, politeFetch.ts, normalize.ts)
│  │  ├─ chess/              (fen.ts normalize, classify.ts win%, phase.ts Lichess Divider port, sanFrom.ts a move's start square from FEN + SAN,
│  │  │                       features.ts per-game features; openings.ts in Stage 4)
│  │  ├─ stats/summary.ts    (the dashboard's one $facet pipeline + response shape, SUMMARY_VERSION)
│  │  ├─ agent/              (tools/*.ts incl. candidates.ts, loop.ts, verifier.ts, prompts.ts, schema.ts,
│  │  │                       model.ts + gemini.ts + scriptedModel.ts (dev), pacer.ts, context.ts,
│  │  │                       coach.ts runtime, budget.ts kill switch + daily budget, friendly.ts error codes,
│  │  │                       basis.ts analysedGamesHash, reportStore.ts, runs.ts run store + event bus,
│  │  │                       runExpiry.ts which runs the TTL may delete; Stage 6: ask.ts question task +
│  │  │                       answer verifier, slots.ts number slots, answerStore.ts, runTokens.ts;
│  │  │                       chunk C: suggestions.ts the chips, demoAnswers.ts demo pre-answers;
│  │  │                       Stage 8 chunk H: credit.ts out-of-credit hold (HTTP 402), colour.ts outcome/intensity phrases)
│  │  ├─ routes/             (players, games, jobs (SSE stream), analysis, summary, positions,
│  │  │                       coach (GET/POST report), ask (POST question), runs (SSE stream), health)
│  │  ├─ middleware/         (requestId.ts, errorHandler.ts, rateLimit.ts, budget.ts)
│  │  ├─ ops/                (Stage 6 chunk D: status.ts, the read-only ops:status queries + text)
│  │  └─ lib/                (logger.ts + log context, processErrors.ts uncaught errors (Stage 8), sse.ts helpers, cursor.ts pagination cursors,
│  │                          validate.ts zod → 400, sleep.ts, version.ts (+ deploy commit), explain.ts explain summaries,
│  │                          demo.ts frozen demo players; Stage 6: visitor.ts IP hash, quota.ts atomic
│  │                          counting windows, storage.ts storage gate, guards.ts limits from env;
│  │                          Stage 8: eviction.ts storage eviction at the gate)
│  ├─ scripts/               (test helpers: testDb, testServer, fakeFetch, fixtures, sseClient;
│  │                          importOnce, explainGames, explainSummary, extractFeatures (backfill),
│  │                          fetchDivisionFixture; coach: coachTools, coachCli, coachFixture, fakeModel;
│  │                          one-off fixes: backfillClassifications, fixUndefinedOpenings;
│  │                          Stage 6: askOnce (npm run ask), demoAnswers (npm run demo:answers),
│  │                          opsStatus (npm run ops:status))
│  └─ .env.example
├─ docs/explain/             (saved .explain() output for the README)
├─ docs/img/                 (the README's screenshots, from web/scripts/ui-readme-shots.mjs; demo.gif, the 40 s walkthrough at the top of the README, from web/scripts/record-demo.mjs + ffmpeg, commands in its header)
├─ web/
│  ├─ src/app/               (/, /p/[platform]/[username], /p/.../game/[id] (?ply=N), /p/.../coach;
│  │                          not-found.tsx the 404 page, error.tsx the page shown when a page throws (Stage 8);
│  │                          opengraph-image.png + .alt.txt the link-preview picture (Stage 8, made by npm run og:image);
│  │                          /dev/engine: engine timing lab used for the Stage 2 measurements, dev only (404 in production))
│  ├─ src/lib/               (api.ts, useJobStream.ts, useWakingRequest.ts + waking.ts (the retry rules, no React),
│  │                          gamesLoader.ts (the dashboard's games paging, merging, one load at a time), format.ts,
│  │                          ribbon.ts, timeline.ts replay + SAN, winPercent.ts graph + accuracy,
│  │                          filters.ts URL ⇄ filters, useSummary.ts + refetch.ts, plyParam.ts,
│  │                          securityHeaders.ts (Stage 8: the site's headers + CSP, used by next.config.ts),
│  │                          coach.ts button state + stat/facts text, checked.ts (where each figure on a pattern
│  │                          card comes from, §12), runStream.ts + useRunStream.ts,
│  │                          useCoachInfo.ts; Stage 7: useReveal.ts + stagger.ts, useIndicator.ts,
│  │                          dashboardStart.ts + summaryPrefetch.ts, mountQueue.ts + useMountWhenNear.ts,
│  │                          printCarry.ts (the landing's print carried onto the demo dashboard, §12),
│  │                          firstRows.ts (Stage 8: how many rows of the games list render at once),
│  │                          perfProbe.ts + perfStats.ts (?perf=1); Stage 6: ask.ts box/answer/error rules,
│  │                          askHistory.ts this visit's questions)
│  ├─ src/components/        (PlayerSearch, PlayerDashboard, ImportProgress, GamesList, HealthStatus,
│  │                          MotionProvider, AnalysisBar, Notice (the short "nothing to show" message);
│  │                          review/: GameReview, Board, EvalGraph, MoveList, BetterMove, classes;
│  │                          MiniBoard (a small view-only board: plain squares, pieces from public/pieces/, two arrows);
│  │                          patterns/: PatternsDashboard, Filters, Blunderprint (canvas) + geometry.ts,
│  │                          HeatBoard + heat.ts, Plate + digest.ts (the plate), link.ts (print ⇄ board),
│  │                          OpeningsTable, charts/ (StackedBars, AnimatedNumber, scale.ts, sample.ts);
│  │                          coach/: CoachButton, CoachPage, AgentTrace, PatternCard, StatLine,
│  │                          EvidenceBoard, FingerprintLens + lens.ts, AskCoach, AnswerCard, Figure,
│  │                          Checked (a figure that says its source);
│  │                          landing/: HeroWords (the masthead, headline and the three ruled rows) + Arrow,
│  │                          Dive (the scroll-driven dive, canvas + board) + diveTimeline.ts,
│  │                          heroTimeline.ts (the first screen's timing), demoData.ts,
│  │                          PrintLink ("Open this Blunderprint": warms the summary, starts the carry))
│  ├─ src/data/demo.json     (committed landing snapshot of the frozen demo player)
│  ├─ src/engine/            (stockfish.ts worker wrapper, uci.ts parsing, analyseGame.ts,
│  │                          replay.ts, scheduler.ts claim/analyse/post + Web Lock,
│  │                          useAnalysis.ts React hook, throughput.ts s/game)
│  ├─ scripts/copy-engine.mjs (predev/prebuild: copies the engine from node_modules/stockfish)
│  ├─ scripts/snapshot-demo.mjs (by hand, npm run snapshot:demo: live API → src/data/demo.json, incl. the dive's move)
│  ├─ scripts/og-image.mjs   (by hand, npm run og:image, with the built site running: demo.json → src/app/opengraph-image.png)
│  ├─ scripts/make-pieces.mjs (by hand: react-chessboard's 12 piece drawings → public/pieces/*.svg, committed)
│  ├─ scripts/ui-*.mjs       (Stage 7 checks over headless Chrome, run comments at the top of each:
│  │                          ui-audit hover/press/focus, ui-motion reduced motion + no frames + 390 px,
│  │                          ui-cls layout shift, ui-frames long frames, ui-labels, ui-shots;
│  │                          ui-games-frame: the games list's render frame at 4× CPU (Stage 8 chunk D);
│  │                          ui-csp: Content-Security-Policy violations on every page + one engine run (§13);
│  │                          ui-contrast: the contrast of all visible text against WCAG AA (§12);
│  │                          record-demo: the README's demo GIF, a scripted walkthrough with a drawn cursor, takes the site URL,
│  │                          safe on live: clicks only a chip the API says is answered, else it stops;
│  │                          ui-readme-shots: the README's screenshots → docs/img/, takes the site URL,
│  │                          safe on live: clicks only a pre-answered chip, never types a question)
│  ├─ public/pieces/         (committed: our own copy of the 12 piece drawings, for the small view-only boards)
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
  lastViewedAt,           // used by the storage eviction (least recently viewed first); written at most once an hour
  evictingAt?,            // Stage 8: set while the player is being evicted; usernameLower is then "~evicting:<id>"
  importMeta: {           // what a re-import needs to fetch only what's new
    monthEtags: { "YYYY/MM": etag },  // Chess.com month ETags; a 304 means that month is unchanged
    newestGameAt,         // newest stored game in platform time (Chess.com end_time, Lichess createdAt,
                          // because Lichess's `since` filters on createdAt); set only when an import finishes
    lastAutoRefreshAt } } // Stage 6: when the dashboard last started an uncounted automatic refresh
                          // (one per player per 6 h, §11 POST import); never sent to the browser
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
{ _id, type: "import"|"extract"|"report"|"ask", key (idempotency key, e.g. "import:chesscom:hikaru", "extract:<playerId>",
                                                "report:<model>:<playerId>", "ask:<model>:<playerId>:<questionKey>"),
  payload, status: "queued"|"running"|"done"|"failed",
  attempts, maxAttempts, runAfter, leaseUntil, workerId,
  progress: { done, total, message },
  checkpoint?,           // handler's resume point, e.g. Chess.com months done / oldest Lichess createdAt
  error?,                // { code, message }, safe to show the user
  finishedAt? }          // Stage 6: set when the job becomes done or failed (complete, final fail, reaper)
```
Indexes: `{ status: 1, runAfter: 1 }`; unique partial index on `key` where status is queued or running, so the same job can't be queued twice; TTL `{ finishedAt: 1 }` with `expireAfterSeconds` 7 days (`FINISHED_JOB_TTL_SECONDS`), so finished jobs are deleted a week later.
- **Startup backfill** (`backfillFinishedAt`, non-fatal): finished jobs from before Stage 6 get `finishedAt = updatedAt` (a pipeline update, `updatePipeline: true`, timestamps off), so the old ones expire too.
- Safe because nothing treats a finished job as a state marker (checked 11 Nov 2026): every read of jobs is for queued/running ones, except the job SSE stream by id (a deleted job is a 404) and the dev script `importOnce`. "Done" lives elsewhere: `Player.lastImportedAt`, `features.version`, `analysis.status`, the AgentRun. And no transition revives a finished job: every move back to queued/running (`claimNext`, retry in `fail`, `release`, the reaper) filters on queued or running, and `enqueue` always inserts a new document.

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
agentRuns: { playerId, kind: "report"|"ask", jobId, status: "queued"|"running"|"done"|"failed", rev, attempt,
             model, promptVersion, analysedGamesHash, steps: [ TraceStep ] (≤ 60), usage, reportId?,
             error?: { code, message } (always the friendly pair), startedAt, finishedAt,
             question?, answerId?, tokenHashes?,    // ask runs only (Stage 6 chunk B)
             refundIds? }  // Stage 8 chunk H: the usage counters the starting visitor paid with (§10 "Out of AI credit")
answers: { playerId, questionKey, question, analysedGamesHash, promptVersion, model, answeredBy, runId,
           outcome: "answer"|"cannot_answer", reason?, sentences: [template with {{name}}],
           slots: { name: { text, kind, value } }, evidence: [ as a report's ], analysedGames, usage,
           durationMs, removed (logs only), expiresAt }
```
- `analysedGamesHash` (`agent/basis.ts`): SHA-1 of `FEATURES_VERSION` + the sorted ids of the player's analysed games with current features. Taken when a run **starts**, so games analysed during a run make the report stale instead of mislabelled.
- `reports` indexes: unique `{ playerId, analysedGamesHash, promptVersion, model }` (the cache key; the model is part of it) and `{ playerId, model, createdAt: -1 }` (latest report). Only the **newest report per player and model** is kept: older ones are deleted after the new one is saved. Per model, so a local scripted run never deletes a real report.
- Each evidence item also stores its game's move `ribbon` (the coach page's fingerprint lens). Reports saved before that (Stage 5 chunk D) get their ribbons filled on first read: one query, saved back without touching `updatedAt`, no AI call (`withRibbons`).
- `answers` (Stage 6 chunk B, "Ask the coach"): unique `{ playerId, questionKey, analysedGamesHash, promptVersion, model }` is the answer cache (`questionKey` = SHA-1 of the question lowercased, spaces collapsed, trailing ?.! dropped). Only the newest answer per player, question and model is kept. TTL on `expiresAt` (written + 30 days), so one-off questions don't pile up; the demo player's pre-answers (`npm run demo:answers`, §10) are written with no `expiresAt`, so they're kept, and so are their runs.
- `usage` (runs, reports, answers) is `{ calls, inputTokens, outputTokens, thoughtTokens, totalTokens }`; `thoughtTokens` since Stage 8 chunk H (absent on older documents).
- `refundIds` (Stage 8 chunk H): the `usage` counter ids (`ip:<hash>|reports|<day>`, or the asker's hour and day counters) taken when the run was started. Removed in the same atomic update that reads them for the refund (`refundRunQuota`, runs.ts), so a refund happens once. Never sent to the browser.
- Ask runs' `tokenHashes`: SHA-256 of each secret token handed out for the run (≤ 20), never the tokens themselves (§10 "Ask the coach").
- `agentRuns`: TTL index on `expiresAt` (`expireAfterSeconds: 0`, Stage 7; it replaced a 14-day TTL on `createdAt`). Every run is created with `expiresAt` = created + 14 days; only the run behind a **demo player's current report** has none, so the demo's "How this report was made" never expires. `agent/runExpiry.ts` `syncRunExpiry` keeps those runs and dates every other run without one (createdAt + 14 days), at startup and after each saved report.

### usage (limits and AI budget)
`{ _id: "<scope>|<window>", count, expiresAt }`. A day window is a **Pacific-time** date (`<yyyy-mm-dd>`; Google's daily quota resets at midnight Pacific), an hour window a UTC hour (`<yyyy-mm-ddTHH>`). Scopes: `global:ai` (real model calls), `dev:scripted` (the local scripted model, so dev runs never use the real budget), `global:new-players`, and per visitor `ip:<hash>|imports` (hour + day), `ip:<hash>|reports` (day) and `ip:<hash>|asks` (hour + day). TTL index on `expiresAt` (a day window: 3 days after it ends; an hour window: 1 hour after).
- All counting goes through `lib/quota.ts`: one atomic `findOneAndUpdate` with upsert per take (`count < limit → $inc 1`), duplicate-key (11000) retried once; `take(rules)` is all-or-none (refunds what it took when a later rule refuses or the DB errors); `refund` is `$inc -1` while `count > 0`. `agent/budget.ts` uses the same code.

### Storage budget (enforced, not hoped for)

| Data | Budget |
|---|---|
| positionStats + openings | ≤ 300 MB including indexes |
| players + games + reports + runs | ≤ 150 MB |
| Headroom | ~60 MB |

**Storage gate (Stage 6, built):** no NEW player is imported once `dataSize + indexSize` (`dbStats`) reaches `STORAGE_NEW_PLAYER_LIMIT_MB` (120 MB): 503 `storage_full`. Stored players can still be refreshed. `lib/storage.ts` caches the reading for 5 minutes and fails open (a failed `dbStats` logs a warning and isn't cached). `/api/health` shows `storageMb` and `storageLimitMb`.

**Storage eviction (Stage 8 chunk E, built 20 Nov 2026; `lib/eviction.ts`).** It replaced the planned "storage guard job": there is no job and no timer.
- **When:** only when POST import finds the gate full for a NEW player, and only as that route's LAST check, right before the enqueue (§10 "POST import check order"): a visitor over their limit, the day's new-player cap or a full queue is refused first, and nothing is deleted for them. Below the gate the code never runs. **Tested, but it has never triggered in production** (the live database is at ~9 MB).
- **How much:** in the request, the least recently viewed players are evicted until the ESTIMATE is 2 MB under the gate (`EVICT_GATE_MARGIN_MB`), then the import goes through. The same round continues in the background, not awaited, down to `STORAGE_EVICT_TO_MB` (100), so the next ~20 new players need none. At most 25 players per round (`EVICT_MAX_PER_ROUND`). If the request can't get under the gate: 503 `storage_full`, and the counters the request had taken are refunded.
- **One round at a time per process:** a new player arriving while a round runs gets 503 `busy` in its own words ("We're making room for new players…", `queue: "eviction"` in `friendly.ts`) + Retry-After 60 s, counters refunded.
- **The estimate:** the gate's reading minus the BSON size of each evicted player's games (one `$bsonSize` aggregation; reports, answers and runs aren't counted, so it errs toward evicting slightly more). The gate's 5-minute cache is cleared when the round ends (`StorageGate.reset()`).
- **Never evicted:** a demo player (left out of the query AND checked in code); a player viewed in the last **7 days** (`EVICT_PROTECT_VIEWED_MS`: recruiters come back to their own import days later); a player with a queued or running job (import by name, extract / report / ask by id); a player with a queued or running coach run; a player with games under an unexpired engine claim.
- **One player, in this order:**
  1. **Mark:** one atomic update sets `evictingAt` and replaces `usernameLower` with `~evicting:<id>` ("~" can't be in a username). Every route finds a player by `{ platform, usernameLower }`, so the player is 404 everywhere from that moment with no route knowing about eviction, and an import of the same name creates a fresh player. The update's filter repeats "not viewed in 7 days", so a view that lands first wins.
  2. **Re-check** jobs, runs and claims; if one appeared, the mark is undone (if the name was taken meanwhile, the old player stays marked for a later round).
  3. Delete answers → reports → agentRuns → games → the player document **last**.
- **A crash mid-way** leaves a marked player; every round finishes marked players first (from step 2), even when the gate is no longer full.
- **Jobs are not deleted:** active ones block eviction, finished ones expire by TTL.
- **Logs:** `eviction_started` / `eviction_done` per phase (`request` / `background`: used, target, evicted, freed, reached, ms), `player_evicted` per player (name, last viewed, counts, ms), `eviction_skipped` (a count per reason: demo, viewed, active_job, coach_run, claimed_games), `eviction_failed`. A refusal while a round runs is `limit_refused` with guard `eviction_busy`.
- **Not closed (no transactions):** a request that read the player just before the mark and enqueues a job just after the re-check. That job finds no player and fails with the usual "player not found".
- **Measured:** one 200-game player (~1 MB), 13 database calls: 17–27 ms against the tests' in-memory MongoDB. On Render it is network-bound; expect a few tenths of a second per player (NOT measured on Render: the live database is at 9 MB, far from the gate). The request part is normally 2–3 players.
- New index for it: `agentRuns { playerId: 1, status: 1 }`.

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
  - **v3 (UI pass, 20 Nov 2026), so the dashboard can link the print and the heat board:**
    - each ribbon has `marks`: one `[ply, square, san, winDrop]` per error of that game (`[]` until its features are extracted);
    - each square has `cost` (the win-chance points lost there, added up) and `worst`: its costliest error (`gameId, ply, kind, san, winDrop, fen, playedUci, betterUci`), picked with `$top` (biggest drop, then the newer game);
    - `totals.accuracy`: the average move accuracy over the analysed games.
    - **`playedUci` comes from `chess/sanFrom.ts`:** features store the move as SAN and only its destination square, so the start square is worked out from the position and the SAN by piece geometry (no chess.js at request time: Render's CPU). It doesn't check pins, so when two pieces of a kind could reach the square and SAN names neither, it answers null and the page marks the square instead of drawing an arrow. Tested against chess.js on every legal move of seeded random games. On the demo player all 120 worst moves got a start square.
    - **Measured on the demo player (200 games, 990 errors):** 58.4 KB of JSON → 105.3 KB; with Brotli at quality 4 (the setting that reproduces Render's sizes) 8.8 KB → 22.8 KB. Filtered (White + bullet): 33.5 → 56.0 KB, 4.8 → 11.4 KB. The marks are ~8 KB of that on the wire and the worst moves ~5.6 KB; it is real information (990 moves, 120 positions), and the tightest encoding tried (marks as one string per game, the worst move as an array pointing at its row) only got to 19.9 KB, so the readable shape stayed.
    - No `FEATURES_VERSION` bump: everything is read from features already stored (a bump would change `analysedGamesHash` and make every report stale).
  - **Unfiltered**, it's cached in `players.summary` (with `SUMMARY_VERSION`, now 3). A rebuild only writes if no newer summary is stored, and `generatedAt` is stamped **before** the read, so a slow rebuild of older data never wins.
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
1. A system prompt (`PROMPT_VERSION`, now 8) sets the job: choose 3–5 **recurring** patterns from the code-found candidates and explain them, with evidence from that candidate's examples. Say "not enough data" instead of guessing.
2. **Two phases** (only stable features; tools + structured output in one request is Preview and timed out in the first real run):
   - **Investigate:** tools only. Run the tool calls, append the results (each carries its step number), repeat until the model is done.
   - **Answer:** one call with structured output and no tools; one format retry if the JSON can't be read.
   - Hard limits: **10 model calls** (`COACH_MAX_MODEL_CALLS`, two kept back for the answer) + **2 repair calls**, 120K tokens, **60 s per call**, **300 s per run**. These count logical calls; every real request, retries included, counts against **`COACH_MAX_REQUESTS` (16) per run**, and the investigation stops early rather than use the last 4 (the answer call + its retries), so a stormy investigation can't starve the answer.
   - Retries: a 429 waits (Google's delay when given, up to 3 times). **Overloaded** (503 "high demand", or a 5xx saying UNAVAILABLE/overloaded): up to **3 retries** waiting ~2 s, 6 s, 15 s (±20% jitter); after **2 in a row** on one call the rest of the run switches to **`GEMINI_FALLBACK_MODEL`** (`gemini-3.1-flash-lite`: Stable, function calling + structured outputs; shuts down 7 May 2027). A timeout / network / other 5xx gets one more try. Every request counts in the daily budget, and every model error is logged with its phase (investigate / answer / repair).
   - **Out of prepaid credit** (HTTP 402, or any status whose message says the prepayment credits are depleted; checked before the 429 branch): the run ends at that ONE request. No retry, no fallback switch. See "Out of AI credit" under Guards.
   - **Thinking levels (Stage 8 chunk H):** `GEMINI_THINKING_INVESTIGATE` goes with every tool-calling call and the repair round, `GEMINI_THINKING_ANSWER` with the answer call (and its format retry), as `generation_config.thinking_level`. Unset = nothing is sent. Only the MAIN model gets one, never the fallback. Both are unset today (gemini-3.5-flash-lite), so nothing is sent. Thinking is billed as output; the API reports it as `total_thought_tokens`, stored as `usage.thoughtTokens` and logged in `report_done` / `ask_done`. It counts toward `COACH_MAX_TOKENS` (through `total_tokens`).
   - Why: on 5 Nov 2026 both live runs on Render failed on Google's 503 "currently experiencing high demand" (the answer call failed twice in a row). A probe of the answer-shaped request (full schema, no tools) completed in 1.9 s, so the schema wasn't the cause (`npm run coach:probe`).
   - **Rate limit:** one process-wide pacer (`agent/pacer.ts`): calls ≥ 60 000 / `GEMINI_RPM` ms apart (4 s at 15 RPM) and under `GEMINI_TPM` in any 60 s.
3. The answer's schema: `patterns: [ { candidateId, explanation, evidenceStep, evidence: [ { gameId, ply } ], drill } ]`. The model writes **no number and no title**: the verifier copies the statistic, baseline, direction and label from the candidate ("7.9 vs your 3.1").
4. **Verifier (code, not AI):**
   - The candidate must have come back from `get_weakness_candidates` in this run.
   - `evidenceStep` must be a `find_example_mistakes` step whose filters EQUAL the candidate's `exampleFilter`; every evidence item must be one of its examples, from ≥ 2 distinct games; no position in two patterns; no two patterns whose groups overlap.
   - Prose: digits only from named fields (candidate figures, matching counts, each evidence item's move number / win% lost / clock, bucket bounds); no number words; SAN moves only the pattern's own played/better moves; explanation ≥ 2 sentences and 120 characters, drill ≥ 60.
   - **Colour (prompt v7, Stage 8 chunk H; `agent/colour.ts`):** no outcome or intensity claim nothing backs. What a move cost is said only as its win-chance figure. The list is tight on purpose: "cost(s/ing) you the game / a point / the win…", "costing you … games", "lost you the game", "throw(s)/threw … away", "game-losing", and "dearly", "massive swing(s)", "catastrophic", "disastrous", "devastating", "fatal". Left out because they are ordinary chess prose: "badly", "heavily", "severely", "decisive", "crushing", "massive" on its own ("a massive pawn centre"), "always"/"never", and the size words "much"/"far" ("a much better move").
   - **The scan behind the list (20 Nov 2026, every stored real report and answer on live: 1 report with 3 patterns, 3 answers; the 6 scripted answers hit nothing):** 5 hits, all real colour: "massive swings", "catastrophic king slips" (a drill), "costing you valuable pieces and games", "cost you the game", "cost you dearly". Seen and NOT on the list: "cost you key advantages", "time pressure hits hard", "led to large losses", and "much worse in the endgame" (a size word the ask prompt forbids since v6; code doesn't check it, because "much better move" is ordinary).
   - **Intensity before an error kind (prompt v8, chunk H1.1, 20 Nov 2026):** the v7 report wrote "severe blunders" and "critical blunders". The colour list also has (severe | critical | serious | costly | terrible | huge | big | major) directly before blunder / mistake / inaccuracy (and plurals). Only there: "a critical position" is ordinary.
   - **Field names in prose (prompt v8, chunk H1.1; `fieldNamesIn`, verifier.ts; reports AND answers):** all 4 patterns of the v7 report wrote the tools' own identifier ("result in 67.4 or 65.3 winPctLost"). Any camelCase word (`/[a-z]+[0-9]*[A-Z][A-Za-z0-9]*/`, SAN moves taken out first) or clock-bucket label (`under10`, `from25to50`, `over50`) is a repair issue that names it and says how to write it (`fieldNameAdvice`: "N win-chance points", "per 100 moves", the clock in words; for an answer: "the slot already says …: remove the field name"). Still there after the repair → the sentence is removed. Field names that are also plain words (games, moves, errors, phase) can't be told from prose and aren't checked. The prompts say: write the figure as "N win-chance points", never a field name.
   - On failure, **one repair round** that tells the model what failed. Then whatever still fails is trimmed (bad evidence, if ≥ 2 games remain; unbacked sentences) or the pattern is dropped.
5. Stream every step to the UI over SSE: the kind (model / tool / verify / repair / retry), a short label, a short detail and the time taken. That's the live "agent trace".
6. **Cache** reports by `(playerId, analysedGamesHash, PROMPT_VERSION, model)`, where `model` is the one asked for; a report written by the fallback records it in `answeredBy`. If nothing changed, POST returns the cached report instantly with no AI calls.

### The report job (`jobs/handlers/report.ts`)
- Key `report:<model>:<playerId>`: asking twice returns the same run. `maxAttempts` 2.
- Runs on its **own worker lane** (a second worker that only claims `report` jobs for this process's model), so a report spending a minute on the AI never holds up imports. One report at a time: the pacer is shared anyway.
- A failed run (time limit, model error, no answer) is final, never retried: a retry would spend the calls again. Only errors outside the run (the DB) retry.
- Shutdown mid-run: the run goes back to `queued`, the job is released (attempt refunded), and the next process starts the run **from scratch** (the conversation lived in memory; the calls already made are lost). A hard kill: the reaper requeues; out of attempts → `coach_interrupted`.

### Friendly errors (`agent/friendly.ts`)
Every failure a visitor can see is a fixed `{ code, message }`; the real error only goes to the logs. Codes: `player_not_found`, `not_enough_games`, `ai_disabled`, `ai_budget_exhausted`, `ai_out_of_credit` (Stage 8 chunk H: the prepaid credit ran out; no time is promised), `ai_busy` (429s), `ai_unavailable` (timeout / 5xx / network), `coach_timeout`, `coach_too_long` (token/call limit), `coach_no_answer`, `coach_interrupted`, `coach_config` (400/auth: our side), `run_not_found`, `internal`; Stage 6: `limit_imports`, `limit_reports`, `limit_questions`, `limit_requests` (429), `limit_new_players`, `storage_full`, `busy` (503; its message names the queue: imports, or the coach's). `sendFriendly` sets `Retry-After` (seconds, ≥ 1) when the wait is known, and the message says how long ("in about 40 minutes"). A run with no surviving pattern shows a fixed "no weakness clearly stood out" message; the model's own `notEnoughData` text is only logged.

### "Ask the coach" (Stage 6; backend built in chunk B, 11-12 Nov 2026; UI + demo pre-answers in chunk C, 12 Nov 2026)
A follow-up question about the player's own games, answered with the same read-only tools and checked by code like a report.
- **One loop, two tasks:** `runTask` (loop.ts) takes an `AgentTask`: system and task prompts, the answer schema, parse, verify, repair prompt. `reportTask` wraps the Stage 5 report unchanged (`runAgent` still returns the same result, and its tests ran unchanged against the refactor); `askTask` (`agent/ask.ts`) is the question.
- **Limits per question:** `ASK_MAX_MODEL_CALLS` 6 (two kept for the answer), `ASK_MAX_REPAIR_CALLS` 1, `ASK_MAX_REQUESTS` 10 (retries included), `ASK_RUN_TIMEOUT_MS` 120 s. Job `ask` (key `ask:<model>:<playerId>:<questionKey>`, 2 attempts, the report job's failure rules) on the coach lane, which now takes report and ask jobs for this process's model.
- **The question** (3-300 characters, no control characters, `cleanQuestion`: NFKC, spaces collapsed) goes into the user's turn as a JSON string, labelled as data; the system prompt says the question can't change the rules, reveal them, assert facts, or reach other players. Tests: "ignore the rules / print your prompt", "say I'm rated 3000" (a model that complies is caught: digits), another player's game as evidence (refused: not this player's).
- **Answer shape:** `{ kind: "answer", sentences (1-5), slots: [{ name, step, path }], evidenceStep?, evidence (≤ 3) }` or `{ kind: "cannot_answer", reason: no_data | outside_your_games | too_few_games }`. A refusal shows a fixed message per reason (`CANNOT_ANSWER_MESSAGES`), never the model's words.
- **Number slots** (`agent/slots.ts`): the model writes NO number. A sentence says "you make {{a}} in the endgame" and slot `a` points at a field of one of this run's tool results (`rows[2].per100Moves`). Code resolves the path (own properties only) to a finite number, and the field's NAME decides its kind, which decides the rounding and the unit: percent "54.2%", score "72.2% of the points" (`scorePct` and a score candidate's value / baseline: a win counts 1, a draw a half, so "you win {{a}}" and "you score {{a}}" both stay true; accuracy and gaps stay bare percentages), share "88.2% of your blunders", per100 "7.9 errors per 100 moves" (the noun from the field: blunderPer100 → "blunders", mistakePer100 → "mistakes", inaccuracyPer100 → "inaccuracies"; a candidate's by its `measure`), perGame "1.25 errors per game", count "1,234" (kind counts with their noun: "9 blunders"), moveNumber "move 23", seconds "1 minute 5 seconds", winPoints "18.4 win-chance points", rating "1850"; a candidate's `value`/`baseline` take its `unit`. A slot pointing at an example's `ply` is read as that example's `moveNumber` ("move 59") by code, with no issue and no repair round, and logged in `removed` ("slot {{c}}: ply shown as its move number"); a ply with no move number beside it can't be shown. Fields outside the table (rankScore, step) can't be slots, so a raw 0.2374 can never reach a sentence. The page gets each slot's text and kind (not the raw value) and fills the templates.
- **Verifier** (`verifyAnswer`): per sentence, every `{{name}}` must be a valid slot; no digits, number words, links or markdown left in the prose; moves only the played/better moves of the answer's evidence. Evidence: from one `find_example_mistakes` step of this run, this player's real judged moves, at most 3. One repair round naming every problem; then failing sentences are removed and bad evidence dropped; nothing left → `cannot_answer` (`no_data`).
- **Secret token per requester** (`agent/runTokens.ts`): POST /ask returns `{ runId, token }` (`crypto.randomUUID()`), and every requester gets their OWN token, also someone who asks the same question while it runs (they join that run, free). The run stores only SHA-256 hashes, capped at 20 (one atomic `$push` whose filter checks there's room, `$slice` as a second guard); past the cap a joiner gets 503 `busy`. `GET /api/runs/:id/stream?token=` hashes the token and compares it with every stored hash in constant time; missing or wrong → the same 404 `run_not_found` as an unknown run. Report runs need no token. Request logs drop the query string, so tokens are never logged.
- **Prompt v2** (`ASK_PROMPT_VERSION` 2, after the first live test on 11 Nov 2026): quote the player's own overall figure as a second slot next to any group's rate; cite 2-3 positions when the question is about a kind of mistake; no "most"/"main"/"worst" claims on small samples (say `shareOfErrorsPct`); `no_data` only when a tool returned zero games, `too_few_games` for a handful; "against X" = the player's games on the other side of X. `get_opening_breakdown` takes an optional `name` (case-insensitive, matched in the opening FAMILY, the name before ":", so "Sicilian" never matches "Zukertort Opening: Sicilian Invitation"): every matching ECO code over ALL the player's games, added up in `matching` (the first test missed 6 Sicilians spread over 6 codes, outside the 12 most-played).
- **Prompt v4** (`ASK_PROMPT_VERSION` 4, after the third live test said "most of your blunders… 96.4% of all errors", a share of ALL errors): shares and kind counts carry their noun like rates do: `shareOfErrorsPct` → "96.4% of your errors", the new `blunderSharePct` / `mistakeSharePct` / `inaccuracySharePct` (every `get_mistake_breakdown` row's share within that one kind, over all rows incl. squares not shown; null when the kind has none, and a null can't be a slot) → "88.2% of your blunders", and the counts `blunder` / `mistake` / `inaccuracy` → "9 blunders" / "1 mistake". Other counts stay bare. The prompt says these already include their noun.
- **Prompt v3** (`ASK_PROMPT_VERSION` 3, after the second live test): both sides of every comparison (or claim of sameness) are slots; one slot name per number; a small category inside a meaningful sample is answered with shares and proportions instead of refused, `too_few_games` only when the whole sample is tiny. Verifier: two slot NAMES for the same step + path → issue ("use the same slot name for the same number"); one name twice in one sentence → issue; one name reused across sentences is fine. A sentence naming a move from one of this run's examples whose position isn't cited gets a repair hint naming the step, game and ply to cite.
- **Prompt v5** (`ASK_PROMPT_VERSION` 5, 12 Nov 2026, after the fourth live test wrote "9 blunders blunders" and "under that threshold of your clock left"): clock buckets in fixed words ("when you're short on time", "with plenty of time"), never the bounds or "under that threshold". A noun the model repeats right after a slot that already ends with it ("{{a}} blunders", a = "9 blunders"; "{{b}} of your blunders", b = "3.6% of your blunders") is removed by code (`dropDoubledNouns`, slots.ts: the following words must repeat the END of the slot's text, case-insensitive, singular or plural; longest repeat wins). Cosmetic and certain, so it's no verifier issue and costs no repair round; applied to every answer output (a first check with no issues is the final answer) and logged in `removed` ("doubled noun after {{a}}").
- **Prompt v6** (`ASK_PROMPT_VERSION` 6, 12 Nov 2026, after the first `demo:answers` run saved "6.2 errors per 100 moves errors per 100 moves", cited no positions and said "much worse" for 11.8 vs 11.7):
  - **Prompt:** a question about time trouble, a phase, a kind of mistake or a piece MUST call `find_example_mistakes` with exactly that group's filters and cite 2-3 positions (a two-group comparison cites the weaker group). A colour question compares score AND accuracy, each side its own slot (`byColor.white.scorePct` / `byColor.black.scorePct`, `accuracyPct.white` / `accuracyPct.black`), never `accuracyPct.all`. "Overall" only for the player's own all-games figure, never a group's. Two groups are compared with each other, with no size words ("much", "far", "slightly"…). A move is plain text, never a slot; `moveNumber` already says "move".
  - **Code:** `dropDoubledNouns` also removes a repeat of the slot's whole unit tail (`unitTail`: everything after the number, e.g. "errors per 100 moves", "% of your blunders", "errors per game", "win-chance points", "seconds") or its bare first word, and a word BEFORE a slot that repeats its first word ("on move {{e}}", e = "move 59"). A slot pointing at `played`/`betterMove` gets a repair message: write the move as text, cite its position.
  - **autoCite** (`ask.ts`): the live model never fills the `evidence` array, even when a repair asks (it refers to positions through `examples[i]` slots and names their moves). So when an answer cites nothing, code cites the examples its slots or SAN moves point at: one `find_example_mistakes` step (the one with the most references), at most 3, topped up to 2 from that step. If the answer refers to no example but the run fetched ≥ 2, the repair issue spells out the JSON to add.
  - Live test on DrNykterstein: the 3 chips verified with no repair round, citing 3 / 2 / 0 positions.
- **Prompt v7** (`ASK_PROMPT_VERSION` 7, Stage 8 chunk H, 20 Nov 2026; the report's `PROMPT_VERSION` is 7 too): what a move cost is said only as that position's `winPctLost` slot, never as an outcome or an intensity (the live answer of 12 Nov said "cost you the game" and "cost you dearly"). `colourIn` (colour.ts) makes each such phrase a repair issue; a sentence that still has one is removed.
- **Prompt v8** (`ASK_PROMPT_VERSION` 8, chunk H1.1, 20 Nov 2026; the report's `PROMPT_VERSION` is 8 too): never a field name in a sentence (a slot's text already carries the unit, so `winPctLost` belongs in a slot's path only), and no intensity adjective before an error kind. Both are code checks (the report's Verifier list above).
- **Code checks added with NO prompt bump (20 Nov 2026, after the first `--force` run saved "Ke3 on 60.3 win-chance points lost 4 seconds"; `slots.ts`):**
  - **The word next to a slot must fit its kind** (`slotContextProblems`): right before a slot, "on" / "at" → a move number; "lost" / "cost" / "costs" / "costing" (+ "you") → win-chance points; a slot followed by "left" / "remaining" → a clock time. A mismatch is a repair issue naming the phrase, the kind it needs and the slot's own field; still wrong after the repair → the sentence is removed. Only these contexts, and not where the word is ordinary with that kind ("based on {{n}} games", "stands at {{a}}", "lost {{n}} of those games", "at {{e}} on the clock"). Every figure in that sentence was real: only the wiring was wrong, which no earlier check looked at. A report's prose has no slots, so nothing to check there.
  - **A capital letter and a full stop** (`tidySentence`): each sentence starts with a capital (not a sentence that starts with a pawn move, "e5 was better") and ends with . ! or ? (a "." is added; a trailing comma or colon gives way). Cosmetic and certain like `dropDoubledNouns`: no issue, no repair round, logged in `removed` ("capital letter added", "full stop added").
- **Dev script:** `npm run ask -- <platform> <username> "<question>"` (`scripts/askOnce.ts`) runs one question against the real model and budget from `backend/.env`, prints the trace, the answer as the page shows it (with each slot's step and path) and what was repaired or removed. Writes nothing but the budget counter.
- **Answer cache:** `answers` (§7). A cached answer is served with no AI call (even with the AI off) and costs the visitor nothing.
- **Suggested questions** (`agent/suggestions.ts`, `SUGGESTED_QUESTIONS`): the same three chips for every player ("Why do I lose so many games in time trouble?", "Am I worse in the opening or the endgame?", "Do I play worse with Black?"). GET report sends them as `ask.suggestions: [{ question, answered }]`, `answered` = a cached answer exists for this data, prompt version and model.
- **Demo pre-answers** (`npm run demo:answers`, `scripts/demoAnswers.ts` + `agent/demoAnswers.ts`): answers the demo player's three chips with the REAL model, the live database and the shared budget (≤ 10 requests per question not yet answered; answered ones are kept, free), through the real job path (its worker claims only the jobs it enqueued and never reaps). Answers and runs are kept with no expiry, so a visitor's chip click is served from the cache.
  - **Re-run rule:** after every `ASK_PROMPT_VERSION` bump or `GEMINI_MODEL` change (both are in the cache key), run it against live, THEN set `DEMO_ANSWERS_PROMPT_VERSION` (`suggestions.ts`) to the new version. `suggestions.test.ts` fails until then, and the API's startup log warns `demo_answers_stale` while a demo chip has no current answer. Until it's re-run, the first visitor to click a demo chip spends real AI calls.
  - **Locally, set the model explicitly** (my `backend/.env` has no `GEMINI_MODEL`, and the code default may not be what Render runs): `set DEMO_PLAYERS=lichess:DrNykterstein&& set GEMINI_MODEL=<Render's GEMINI_MODEL>&& npm run demo:answers` (process env wins over `--env-file`).
  - **`npm run demo:answers -- --force`** (20 Nov 2026): answers ALL the chips again, also the ones with a current answer, and replaces those answers; prints each answer it replaced. For a change to how answers are checked or worded that didn't bump the prompt version (the cache key is unchanged, so nothing else would re-answer them). The old answer stays until the new one is saved (a chip is never unanswered in between; a failed run leaves it). The flag travels in the job's payload (`force`), because the live server's coach lane may claim the script's job first: **the live API must already run code that knows it**, or its worker serves the cached answer. POST /ask never sets it. Demo players only, like the whole script.
  - **`--question "<exact chip text>"`** (with or without `--force`): ONE chip only, the others untouched. It must be one of the chips, word for word; any other text is refused (that would be a typed question, not a demo answer).
  - Last runs: prompt v8, 20 Nov 2026, 13 requests, all 3 kept; then `--force` after the ply and score changes (same day).
- **The page** (chunk C step 2; `coach/AskCoach.tsx`, `AnswerCard.tsx`, `Figure.tsx`; rules in `lib/ask.ts` and `lib/askHistory.ts`, tested): under the report on the coach page, for a player with enough analysed games.
  - A question box (300 characters, counted after the API's cleaning; the counter is announced politely, only near the limit), the privacy note, and the three chips (an answered chip works even with the AI off and says "(answer ready)" to screen readers; the box needs the AI).
  - This visit's questions, oldest first, in memory only (a reload starts empty). One at a time; a new card is added at the BOTTOM and scrolled into view, so nothing above it moves.
  - POST /ask 200 → the cached answer at once, with its trace; 202 → the live trace over the run stream with the visitor's token, which stays in component memory (never the URL, storage or logs).
  - The answer: serif sentences along an ink hairline (not a chat bubble), every number a `Figure` (Geist Mono on a teal rule that draws in; with reduced motion or no frames it's simply there), then the fingerprint lens and the report's evidence boards. The trace folds into "How this answer was made" (no extra request).
  - Failures: the API's friendly message (`askErrorView`); Try again only where it can help (`busy`: after Retry-After, which CORS now exposes to the page).
  - **Live checks** (12 Nov 2026, blunderprint.vercel.app, chip clicks only, all cached): ui-audit coach-ask 30 controls, 0 failures; ui-motion all 5 pages ok (reduced motion, no frames, 390 px); ui-labels ask ok; ui-cls `ask` CLS 0.000 (each answer shown in ~0.3-0.5 s). ui-audit, ui-motion and ui-labels take their base from `ui-cdp.mjs` (localhost); for live, run copies with `BASE` changed. Never run `ask-typed` against live: it spends real AI calls.
- `ask_done` log line per answer: outcome, reason, sentence/evidence counts, what was removed, calls, tokens, ms (never the question).

### Guards
- **Per-visitor limits (Stage 6 chunk A, built):** 5 imports/hour and 15/day (`LIMIT_IMPORTS_PER_HOUR`, `LIMIT_IMPORTS_PER_DAY`), 3 reports/day (`LIMIT_REPORTS_PER_DAY`), 6 questions/hour and 20/day (`LIMIT_ASKS_PER_HOUR`, `LIMIT_ASKS_PER_DAY`, chunk B, their own `ip:<hash>|asks` counters). Only work that really starts counts: a cached report, a rejoined job, an up-to-date or frozen player are free, and a count is refunded if the enqueue fails or someone else's identical job was rejoined.
  - **Visitor = HMAC-SHA256 of the IP** with `IP_HASH_SALT` (first 32 hex chars, `lib/visitor.ts`); IPv6 is reduced to its /64 first (`ipKeyGenerator(ip, 64)`, which also folds IPv4-mapped addresses). Raw IPs are never stored or logged; refusal logs carry only the first 8 chars of the hash. Changing the salt resets everyone's counters. Production refuses to start without a salt of ≥ 32 characters; locally an empty one means a random salt per process.
  - **POST import check order** (cheapest and global first, then the visitor's own counters, the eviction LAST because it deletes other players' data): storage gate reading (new players only; full just sets "room is needed", or 503 `storage_full` at once when there is no evictor) → queue cap (`IMPORT_QUEUE_MAX` 10 queued imports, 503 `busy`, Retry-After 60 s) → the visitor's import limits (429 `limit_imports`) → the global new-player cap (`NEW_PLAYERS_PER_DAY` 40 per Pacific day, 503 `limit_new_players`; refunds the visitor's count) → **if room is needed, the storage eviction (§7)**: `full` → 503 `storage_full`, `busy` → 503 `busy` ("We're making room for new players. Try again in a minute.", Retry-After 60 s); both refund every counter taken. So a request another check refuses never evicts anyone. Demo players skip all of it.
  - **Automatic refreshes don't count:** `?trigger=auto|user` (query string, so no CORS preflight; default `user`, unknown values 400). `auto` for an already STORED, non-demo player skips the visitor's import counters but is held to one per player per 6 h by `importMeta.lastAutoRefreshAt`, claimed atomically (of two tabs, one starts it; the other gets 200 `upToDate`). A refusal (queue full) or a failed enqueue hands the slot back. New players always count, whatever the trigger. The dashboard sends `auto` on load and `user` after a Try again / Retry click.
  - **POST report:** the visitor's report limit is taken after the budget check (429 `limit_reports`) and refunded if the run doesn't start.
  - **POST ask:** the coach queue cap (`COACH_QUEUE_MAX` 5 queued report/ask jobs, 503 `busy`, Retry-After 60 s) comes before the visitor's question limit (429 `limit_questions`), so a full queue doesn't use up a question; joining a running question and a cached answer are free; a failed enqueue refunds the count and deletes the run it created.
  - **Flood guard** (`middleware/rateLimit.ts`, express-rate-limit 8.7.4 pinned): `LIMIT_REQUESTS_PER_MINUTE` (300) per visitor on `/api`, in memory, `/api/health` exempt, 429 `limit_requests` + Retry-After.
- Global daily AI call budget (`AI_DAILY_CALL_BUDGET`, default 400, under the 500/day free limit, Pacific-time days) and a kill switch (`AI_ENABLED=false`) that shows a friendly message (built in Stage 5, `agent/budget.ts`):
  - Checked before a run starts (POST refuses below one worst-case run: `COACH_MAX_REQUESTS` = 16 requests) AND before every model request, retries and fallback included (`guardedModel`).
  - One atomic `findOneAndUpdate` with upsert per request: `{ _id: day, count < budget } → $inc 1`. A duplicate-key error (11000) is retried **once**: at the start of a day two first inserts can race, and only a second miss really means the budget is used up.
- **Out of AI credit (Stage 8 chunk H1, `agent/credit.ts`; tested with fake models, never happened on live; it can only happen once the paid tier is on, H2 below).** The paid tier is prepaid credit; at $0 every request gets HTTP 402 until credit is added.
  - **In a run:** the 402 ends it at once (one request, no retry, no fallback: the same account pays for both models). The visitor sees `ai_out_of_credit`: "The coach is resting: its AI allowance has run out. Reports already written are still shown." No time is promised.
  - **The visitor's count is refunded:** the report (or the question's hour and day) counters taken at the start are stored on the run (`refundIds`) and given back when the run fails with `ai_out_of_credit`. Only then: any other failure keeps the count. Someone who JOINED a running question paid nothing, so gets nothing back.
  - **A 15-minute hold** (`OUT_OF_CREDIT_HOLD_MS`, in memory, per process): POST report and POST ask answer 503 `ai_out_of_credit` (no Retry-After) after the kill-switch check; cached reports and answers are still served; GET report sends `ai.outOfCredit: true` and `canStart: false`, and the coach button and stale band say "The coach is resting: its AI allowance has run out." A run already queued fails without sending anything (and takes nothing from the daily budget: the credit gate sits outside the budget guard). When the hold ends the next run is let through: with credit it just works; without, its first request gets the 402 again and the hold restarts. A restart forgets the hold; the first run finds out again with one request.
  - **Logs:** `ai_out_of_credit` at error level (model, status, Google's message), `coach_model_error` with kind `out_of_credit`, `run_quota_refunded` (`run_quota_refund_failed` if the refund itself fails; the run's failure still stands).
  - **Locally:** `COACH_MODEL=scripted` + `COACH_SCRIPTED_SCENARIO=out-of-credit` (every request a 402).
- **H2 at billing (Stage 8 chunk H2; postponed 20 Nov 2026, days or weeks; nothing below is done).** Facts checked in the Claude.ai chat on 20 Nov 2026, to re-check then: prepaid credit with auto-reload off, HTTP 402 at $0; `gemini-3.8-flash` at $0.75 / $3.75 per 1M input / output tokens (output includes thinking; introductory until 31 Dec 2026), takes thinking low / medium / high and thinks at medium by default.
  1. **Privacy note** (`AskCoach.tsx` + the README's Privacy line), my wording: "Questions are sent to Google's Gemini on its paid tier, where Google says it doesn't use them to improve its products, so don't include personal details. Visitors are counted by a hashed address, never a stored IP." Say "Google says", never an absolute.
  2. **README free-tier lines:** the model in the stack table, the "400 a day (Google's free limit is 500)" row, "Cost: nothing", "Everything runs on free tiers"; add the out-of-credit bullet to "Limits, budgets and the kill switch"; the measured tokens and cost.
  3. **Render vars (by me):** `AI_ENABLED=false` first; then `GEMINI_MODEL=gemini-3.8-flash`, `GEMINI_THINKING_INVESTIGATE=low`, `GEMINI_THINKING_ANSWER=medium`, `AI_DAILY_CALL_BUDGET=150`, `LIMIT_ASKS_PER_DAY=10`, the paid tier's `GEMINI_RPM` / `GEMINI_TPM` / `GEMINI_RPD` from AI Studio. The code defaults (400, 20) stay the free-tier values.
  4. **Probe:** `npm run coach:probe` with the new model and levels in the process env; read the thinking tokens it prints.
  5. **The fallback / thought-steps check** (§17): does `gemini-3.1-flash-lite` accept a conversation holding the main model's thought steps?
  6. **Model switch and re-runs:** `npm run demo:answers` with `GEMINI_MODEL` set to the new model (the model is in the answer cache key), `AI_ENABLED=true`, my Refresh click on the demo report, `npm run snapshot:demo` + `npm run og:image`.
  - Cost estimates from real flash-lite usage (1 report: 5 calls, 12,016 tokens in, 2,045 out; 6 questions: 4.7 calls, 15,022 in, 392 out on average), before thinking tokens: a report $0.03–0.06, a question $0.02–0.04, a worst day of 150 requests about $1.50. NOT measured on 3.8-flash.
  - The paid-tier wording that was taken out of H1 is also saved as `stage8-chunkH2-later.patch` on my Desktop (not committed).
- Free-tier note: on the free tier Google may use prompts to improve its models. That's fine here, because all the data is public games.
- When the budget runs out, show cached reports and an honest message. Never show a raw error.
- **Ops status** (Stage 6 chunk D, `npm run ops:status -- https://blunderprint-api.onrender.com` from `backend/`; `scripts/opsStatus.ts`, `ops/status.ts`): one read-only look at the live system. From the database (`backend/.env`): today's AI budget (used / left, the reset at Pacific midnight in my local time; the limit is the local `.env`'s), the scripted counter, `dataSize + indexSize` against the 120 MB gate and Atlas's 512 MB with the biggest collections, the queue per type (queued / running, oldest queued, running jobs with an expired lease), failed jobs and coach runs of the last 24 h, and visitors at each cap today (counts, never a hash). From the live API: `/api/health` (incl. the deploy's commit) and GET /report per demo player, whose `ai.*` and `ask.suggestions` are Render's real AI state and model (GET /report writes nothing for a frozen demo player: checked 12 Nov 2026, its report has every ribbon, so `withRibbons` doesn't save). Ends with "Needs attention" (AI off or resting, storage ≥ 80% of the gate, expired leases, a job queued > 15 min, stale demo answers, the new-player cap reached, the API or its DB down) or "Nothing needs attention".
  - **Refusals aren't countable** without new storage: a counter only goes up while under its limit, so the script shows visitors AT a cap, not refusals. The refusals are Render's `limit_refused` / `storage_refused` log lines.
  - First live run (12 Nov 2026): 50 of 400 calls used, 9.3 MB stored (games 8.6), queue empty, 12 ask runs in 24 h, demo answers all answered, nothing needing attention.
- **Drills on live** (Stage 6 chunk D, 12 Nov 2026, both passed; I changed one Render env var each time and restored it):
  - **(a) Kill switch, `AI_ENABLED=false`:** the question box was disabled with "New questions are paused right now" and the switched-off note; the cached report still showed; a chip served its cached answer at once; a direct POST /ask got 503 `ai_disabled` with the friendly message. Restored.
  - **(b) Budget used up, `AI_DAILY_CALL_BUDGET=1`** (live `ai.budgetLeft` 0, `enabled` true): a typed question got "The coach is resting" with the reset time ("about 15 hours from now"), no Try again button, and the chips stayed enabled; it was refused before any AI call. Restored to 400 (live: 350 left, `canStart` true).
  - Neither state can be shown again without changing Render's env, so the README describes the drills in text (no screenshots of them).

---

## 11. API routes

```
GET  /api/health                                   → { ok, db, queueDepth, version, commit, storageMb, storageLimitMb }
POST /api/players/:platform/:username/import       → 202 { jobId } or 200 { upToDate: true } (idempotent: returns the running job) (?trigger=auto|user, §10 Guards)
GET  /api/players/:platform/:username              → { player, activeJob } (player: profile + importState + counts; no summary)
GET  /api/players/:platform/:username/summary      → { summary, cached, extracting } (?color=&speed=&from=&to=)
GET  /api/players/:platform/:username/games        → cursor pagination (?cursor=&limit=&speed=&color=&result=); limit 1-200, default 20
GET  /api/games/:id                                → game + analysis + features
POST /api/analysis/claim                           → { claimId, expiresAt, games } up to K games to analyse (leases); a demo player: games [] + frozen: true
POST /api/analysis/results                         → evals for one claimed game (validated, idempotent)
POST /api/analysis/release                         → hand unfinished claimed games back (sendBeacon, text/plain)
GET  /api/positions/stats?fen=&band=               → positionStats lookup
GET  /api/players/:platform/:username/report       → { report, stale, staleReason ("new_games"|"new_version"|null), newGames, eligibility: { analysed, needed, ok }, activeRun, ai: { enabled, budgetLeft, canStart, outOfCredit }, ask: { suggestions: [{ question, answered }] } }
POST /api/players/:platform/:username/report       → 202 { runId } / 200 { report, cached: true } / 404 / 409 / 503 / 429 (see below)
POST /api/players/:platform/:username/ask          → 202 { runId, token } / 200 { answer, cached: true } / 400 / 404 / 409 / 503 / 429 (Stage 6, see below)
GET  /api/jobs/:id/stream                          → SSE: job progress
GET  /api/runs/:id/stream                          → SSE: agent steps, then the final result
```
- **POST report** checks, in order: no player → 404 `player_not_found`; a run already going → 202 the same `runId`; a report for exactly this data → 200 cached (no AI call, even with AI off); fewer than `COACH_MIN_ANALYSED_GAMES` (20) → 409 `not_enough_games`; AI off or no model → 503 `ai_disabled`; out of AI credit in the last 15 minutes → 503 `ai_out_of_credit` (§10 Guards); budget under one worst-case run (16 requests) → 429 `ai_budget_exhausted` + `Retry-After` (seconds to Pacific midnight); else 202 `{ runId }`. Error bodies are `{ error, code }`.
- **POST ask** checks, in order: bad body → 400; no player → 404 `player_not_found`; fewer than `COACH_MIN_ANALYSED_GAMES` → 409 `not_enough_games`; this exact question answered for this data → 200 cached (no AI call); the same question running → 202 joined with a token of the visitor's own (past 20 tokens, or the run just ended: the cache is checked once more and serves the answer if it was just saved, else 503 `busy`); AI off → 503 `ai_disabled`; out of AI credit in the last 15 minutes → 503 `ai_out_of_credit`; budget under `ASK_MAX_REQUESTS` (10) → 429 `ai_budget_exhausted`; coach queue full → 503 `busy`; visitor's questions used up → 429 `limit_questions`; else 202 `{ runId, token }`.
- **Run SSE contract** (`GET /api/runs/:id/stream`; an ask run needs `?token=`, §10): the same as the job stream (subscribe → snapshot → only newer revs, `retry: 3000`, 15 s heartbeat, ends after `done`/`failed`, a reconnect starts with a snapshot). Events: `snapshot`, `status`, `done`, `failed` carry the whole public run (`done` and a finished snapshot include the report, or for an ask run `kind: "ask"`, the `question` and the `answer`); `step` carries only `{ step }`. Token hashes are never sent.

Rules:
- Validate every input with zod.
- **Cursor pagination,** not skip/limit.
- **The games list in one request (Stage 8 chunk B, 18 Nov 2026):** the route's largest page is 200 (`MAX_LIST_LIMIT`, = `MAX_GAMES_PER_PLAYER`'s default) and the dashboard asks for 200 (`GAMES_PAGE_SIZE`), so a player's whole list is one request; the loop still follows `nextCursor` (a 201st game pages). A list row leaves out `features` (nearly half of a row; only the summary and the coach read them), the engine's bookkeeping (`engine`, `depthOrNodes`, `durationMs`, `analysedAt`) and the document timestamps.
  - **Measured on the demo player (200 games):** before, live: 8 API requests on the dashboard, the 4 games requests one after another, 71.8 KB on the wire (473 KB of JSON), list complete ~740 ms after its first request started (warm). After, the real route run in-process on the real data: 5 requests, one games request, 215 KB of JSON, ~18.9 KB with Brotli at quality 4 (the setting that reproduces Render's sizes for the old pages: 69.8 KB computed vs 71.8 measured).
  - **The trade:** while a first import streams in, each progress event now re-reads the whole list so far (one request of up to ~19 KB) instead of only its last page of 50.
  - What's left in a row is mostly `classifications` as words; sending one letter per ply (as the summary's ribbons do) would roughly halve it again. Not done: it changes the row's shape for the live-analysis code.
- The SSE endpoints send a heartbeat comment every 15 s and close cleanly.
- **CORS also applies to EventSource,** so the allowlist must include the Vercel site.
- **POST import:** 202 `{ jobId }` starts (or rejoins) an import. 200 `{ upToDate: true }` when the last successful import is under **6 h** old and none is active (Chess.com only refreshes every 12–24 h anyway). Repeating the call is safe: while an import is queued or running, the same job comes back. Stage 6 guards and `?trigger` in §10 Guards.
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
- `/`: landing. The headline, one input (username and platform toggle), and the demo player's print, followed all the way down to one move. **As built (UI pass, 20 Nov 2026; it replaced Stage 7's hero with three margin notes and the "How it works" section):**
  - **The words (v3, 21 Nov 2026; `landing/HeroWords.tsx`, a Server Component handed to the dive as children; `landing/Arrow.tsx` is the drawn arrow):**
    - **A masthead:** one ruled line (44 px, an ink hairline) across the whole page on the page's two columns: "Blunderprint" over the words, "An AI chess coach for your own games" starting at the print's left edge (38%), "Source" at the right edge (from 1280 px). On phones: the name and "An AI chess coach".
    - Headline "Your mistakes leave a print." (60 px; 36 on a phone), then ONE quiet serif paragraph (Newsreader 20 px, graphite): "An engine in your browser finds your mistakes. A coach finds the ones you keep making, and shows you where." It was 18 px Geist and competed with the headline.
    - **Three ruled rows, the demo first** (most recruiters have no chess account, so the demo is the page's main action). **One style for all three (v4, 21 Nov 2026):** serif 20 px in ink, one 24 px arrow on one right edge; the first leads by its place and its mono sub-line, not by its size (it was 24 px serif over a 16 px sans row and a grey sans field: three styles, and three large things competing with the headline).
      1. "No account? See a real one" (with "DrNykterstein's print · 200 public games" under it and an arrow): the link that carries the print onto the dashboard (`PrintLink`).
      2. "Read what the coach found in it" → the coach report.
      3. The visitor's own games on one line (`PlayerSearch.tsx`): a username field with no box, typed and placeholder text in the rows' serif 20 px (the row's rule is its underline; it darkens on hover and focus), the platform as two words (a real radio group: "Chess.com / Lichess", the chosen one in ink and underlined), and an arrow that is the submit button (named "Show games"). Every target is ≥ 44 px tall. An empty or impossible username is refused in words under the row ("Type a Lichess username first.").
    - **Two variants were prototyped** (these rows; and a "sentence" version with the demo as one underlined serif line and the form as "Or yours, on Chess.com / Lichess"). The sentence version didn't fit 1280×593 (the username field fell off the screen) and its two paths read as one paragraph; the rows put the demo first with the largest type and fit every size. Stills: `C:\Users\hp\Desktop\ui-pass\hero\v3\` (not in the repo).
    - **The words are one block (v4):** headline, 24 px, paragraph, 32 px, rows; on wide screens it starts right under the masthead (v3 had a large empty gap there, because the headline was level with the print's top edge).
    - **Both columns start on one line (`--print-top`, `--print-figure`, `--hero-top`, `globals.css`):** from 1280 px the top of the headline's capitals is level with the top of the coach's figure's digits, the right column's first line (measured in the stills: the same pixel row, 77 / 77 at 1920×897 and 61 / 61 at 1280×593). The dive's canvas reads `--print-top` (`getComputedStyle`, passed to `stageBox` as `top`); the headline's margin (`--hero-top`) is a `calc` from the same two values, with offsets measured in stills. It can't be set by script: the words are server-rendered, and moving them after load would be layout shift. **If the figure's markup or the headline's font changes, re-measure the offsets.**
    - **The right column's top is one unit (v4):** the figure, then ONE line with the counter at the print's left edge and the figure's label at its right edge (both mono 14 px in the same 20 px line box, so one baseline: measured, the same pixel rows), then the bracket and the print.
    - **Two settings, stepped with the screen's height**, so the masthead, the figure and 200 rows always fit (tested in `diveTimeline.test.ts`): compact (figure 36 px, its digits 17 px under the masthead's rule) under 700 px (top 140, rows 2 px) and from 800 to 839 px (top 136, rows 3 px); roomy (top 176, figure 60 px, 33 px under the rule) from 700 to 799 px (rows 2 px) and from 840 px (rows 3 px; 4 px from 1040 px). **If a step changes, change the test's table too.**
  - **The entrance (v5, 21 Nov 2026; `hero-in` in `globals.css`):** on a first load, everything on the first screen except the headline fades in and rises 10 px, one after another, 60 ms apart and 240 ms each: paragraph → the three rows → the masthead's tagline and "Source" → the counter. The last ends 600 ms after the first paint, while the print is still developing.
    - **The headline never animates:** it is the Largest Contentful Paint and must be painted at full opacity in the first frame. **Under 640 px the paragraph is the LCP element** (the headline is 36 px there, the paragraph is the larger text), so there the paragraph has no entrance either (`hero-in-from-sm`). Measured before that exception: a phone's LCP moved from the first paint to the end of the paragraph's fade (352 → 688 ms on the local build). Checked after: LCP is the first paint at 1920, 768 and 390 px. **Anything added to the entrance must not be the largest text at its screen size.**
    - **CSS only, a `from` and nothing else:** the final state is each element's normal style; reduced motion turns it off. An element at opacity 0 can still be clicked, focused and typed in (checked: the username field mid-entrance).
    - **Once per visit:** `<html data-hero-seen>` turns it off. `Dive.tsx` sets it 1 s after the page starts (and when the page is left), so a return inside the app shows the first screen at once; an inline script at the top of `HeroWords.tsx` sets it before the first paint when the page was reached with the back or forward button and loaded again (`performance` navigation type `back_forward`); a page restored from the back/forward cache is simply as it was left. A reload or a new visit plays it again. `<html>` has `suppressHydrationWarning` for that attribute.
    - **The figure and its label are NOT in that stagger: they arrive with their evidence** (v5.1, 21 Nov 2026), at 2.7 s, when the band starts to light and the bracket to draw, with the same 240 ms rise (`finding-in`; `Dive.tsx` sets `data-arrived` on the finding at `RECEDE_MS[0]`). v5 had them there from the start, and the claim stood ~2 s before the print showed it. A first screen that is simply final (reduced motion, no frames, a scrolled page) has them at once. They are placed by a transform over the stage, so nothing moves when they arrive. They come with the print's development, so they arrive again on a return inside the app (the print develops again there too).
  - **The dive** (`landing/Dive.tsx`; phases and layout as pure functions in `diveTimeline.ts`, the first screen's timing in `heroTimeline.ts`): one tall block (560 screen heights) with a stage pinned inside it (`position: sticky`). How far the block has been scrolled is one number p from 0 to 1, and p alone decides the picture:
    - **First screen (time, not scroll; rebuilt 20 Nov 2026, `heroTimeline.ts`): the print develops like a photograph, and the coach's finding is drawn on it.**
      - 200 quiet rows arrive (0–0.5 s). The marks then bleed in kind by kind, from the paper's own line colour to full colour: inaccuracies (0.5–1.1 s), mistakes (1.0–1.6 s), blunders (1.5–2.2 s), and last the one move the page follows (2.3–2.6 s). The counter "N games · M errors found" runs with them (the player's name left it in v3: the first row of the words names the print). The whole print is there at 2.6 s (`DEVELOPED_MS`; the scan line it replaced took 4 s).
      - **Then the print SHOWS the coach's finding (v2, 21 Nov 2026).** Over 600 ms (2.7–3.3 s, `RECEDE_MS`, `recedeAt`) the marks BEFORE the stretch the finding is about recede to 45% of their colour (`RECEDED_STRENGTH`; 30% until v3, where the early marks were nearly gone on a 1 px row; mixed toward the paper's line colour), so the stretch itself (move 41 to the right edge) stands as a lit band. Reduced motion and no frames: that final state at once.
      - **The figure is in large type over the band:** "5.5 vs your 3.0" in the coach page's figure style (mono, 60 or 36 px by the screen's height, `--print-figure` above; 36 px under 1280 px), standing on its bracket whatever its size (its height is measured), right-aligned to the print's edge, with code's label under it ("Blunders per 100 moves from move 41 on") and a bracket spanning the band's columns. All from the snapshot's note; nothing is written for the landing.
      - **The ringed move is inside the band, and its note sits to the LEFT of the ring**, over the receded part ("47. Nd4?? · 0:04 left · −49 points. One of 990 marks. Scroll to follow it."), so the band stays clear and the move reads as one instance of the finding.
      - **Pointing at the print (a mouse) brings every mark back to full strength** in 200 ms, to read a game; moving away recedes them again. A scroll does the same (the dive needs the whole print): the receding is multiplied by 1 − seg(p, 0.01, 0.05). A finger does nothing: on a phone a touch on the print is a scroll.
      - Without a "… from move N on" label (`BRACKET_PLY` null: the pattern is a phase, an opening…) nothing recedes and no bracket is drawn; the figure and label still stand.
      - The carry onto the dashboard copies the print as it is shown, so it flies with the early marks receded.
      - **The print is as tall as the screen allows** beside the words: rows 2, 3 or 4 px apart (`stageBox`: 2 on a short laptop, 4 on a 1080 px screen). Under the words (phones) always 2.
      - Beside the words the counter sits over the print's left end, level with the finding's label; on phones it goes under the print, above the caption (the finding takes the 88 px above the print).
      - **The counter is as wide as its final text from the start** (`min-width` in `ch`, the font is mono): while it counted, its growing width moved the name after it, and the load measured CLS 0.0027 at 1280 px. Now 0.0000.
      - **Three directions were prototyped** (the print as the hero; a typographic one with one game's ribbon under the headline; a board that plays the blunder on the first screen). The third was the clearest about chess but shows the dive's last picture before the dive. Stills, GIFs and the reasons: `C:\Users\hp\Desktop\ui-pass\hero\report.md` (not in the repo).
    - **A (p 0.03–0.30):** the print parts around that game; its line opens into single moves. Caption: "Every row is one game. This is one of them."
    - **B (0.33–0.55):** the strip zooms sideways until one move is a square, with the moves' names under it. "Every mark is one move. This one, with 0:04 on the clock."
    - **C (0.57–0.68):** that brick square grows into the board (the position before the move).
    - **D (0.70–0.87):** the piece slides along a rust arrow, slides back, a teal arrow draws the better move.
    - **E (0.88–0.99):** the coach's finding: the pattern's label and number (code's), ONE sentence of the report's explanation that names this move (the model's own words, already verified), the move's own figure underlined by a teal rule, and "✓ 49.4 is this move's own figure. Code checked it, and every other number in the report, against the games." Then "Read the whole report" and "Open this Blunderprint".
  - **Which move:** `scripts/snapshot-demo.mjs` picks it: of the three notes, the costliest whose move is named in a sentence of its pattern's explanation and has both moves as squares. It writes `dive: { note, sentence, figure, sans }` into `src/data/demo.json` (`sans`: that game's moves, replayed from its PGN with chess.js in the script, never in the browser). `diveTimeline.test.ts` checks the block against the snapshot.
  - **Everything on the stage is placed with transforms and opacity,** never `top`/`left` (a moved `top` counts as layout shift; measured through the load and a full scroll: CLS 0.0001 at 1280 px, 0.0003 at 390 px). The stage's parts are found by a `data-el` name and styled directly, so a scroll never re-renders React. One canvas for the print and the strip; the board is 64 divs and our own piece images (`public/pieces/`, fetched 1.5 s after load, so not in the first screen's way).
  - **The canvas is kept on whole device pixels** (`snap` in `Dive.tsx`): the words above the stage can end on a fraction of a pixel (562.84 px at 390 px wide), and a canvas of 1 px rows drawn that far off is resampled by the browser: on a 1x screen the print came out dark and colourless (found in a screenshot; the canvas's own pixels were right).
  - **The captions have their own band of bone** (the other games' rows run behind them), and the final heading is `text-balance`.
  - **The first screen's caption stays with the print** ("One row per game · one mark per error · newest at the top" and "Play the dive"): 12 px under the print's last row, starting at the print's left edge and as wide as the print, at every size. Until 20 Nov 2026 it sat 48 px above the bottom of the whole stage and was as wide as the stage: at 1280×593 that put it across the words, between "No account? Explore the demo:" and its two links. Checked at 1280×593, 1366×650, 1440×800, 1280×900, 768 and 390 px (the caption's box overlaps none of the words' boxes).
  - **"Play the dive"** (first screen): the same scroll, played by the page over 11 s; any wheel, key, touch or click of the visitor's takes over.
  - **Layout:** from 1280 px the words sit over the stage's left third and fade as the print takes the stage; below that they come first in the normal flow and the stage follows. A screen too short for 200 rows of 3 px (a 1366×768 laptop) gets 2 px rows; a tall one gets 4 px rows. Phones: the board is large while its story is told (half the screen), then shrinks to what the coach's words leave under it (`stageBox` `small`, measured from the real heights). Checked at 1280×900, 1366×650, 768, 390 and 360×640: no sideways scroll, nothing cut.
  - **The headline is the LCP element, and the dive can't delay it:**
    - The words are server-rendered; the dive's script only fades them.
    - **The landing skips the route fade** (`globals.css`: `.anim-fade:has([data-dive])`). A text first painted at opacity 0 is never counted as Largest Contentful Paint, so with `template.tsx`'s fade the "largest" element was a small line written by script (the old hero's counter: on live, LCP 2.3 s). Without the fade the hero text is the LCP at first paint. Lighthouse mobile on the local build: 99 / 100 / 99, LCP 0.77 s (before: 93–94, LCP 3.15 s). **The other pages still fade in.**
    - **The dashboard keeps the fade: removing it was measured and changed nothing** (20 Nov 2026, Lighthouse mobile, 5 runs each on a local production build against the live API, same sitting): with the fade median 81 (81 / 81 / 80 / 82 / 81), LCP 4.82 s; without it median 80 (81 / 67 / 80 / 81 / 80; the 67 was a disturbed run, benchmark 1,676 against ~2,600), LCP 4.99 s. The dashboard's LCP element is the plate's sentence in both ("The errors are densest…"), which is drawn from the summary the API sends, so the fade is not what delays it. Local scores are ~6 points under live (86–88) on this laptop.
  - **No animation frames:** if no frame has run 400 ms after load, the first screen is drawn final at once and a scroll paints directly (no `requestAnimationFrame`). A timer also lands the final first screen at 5.3 s.
  - **Reduced motion:** no pinned stage (`motion-reduce:` un-pins it and gives the block its natural height). The first screen's final print with its note, then a second, still stage with the dive's final picture (board, both arrows, the coach's words). No "Play the dive". Read in the effect with `matchMedia`, not kept in React state (a `useSyncExternalStore` version rendered the animated stage first).
  - A screen reader gets one hidden sentence that says what the dive shows.
  - **The print is carried onto the demo dashboard** (UI pass step 4, 20 Nov 2026; `lib/printCarry.ts`, `landing/PrintLink.tsx`). "Open this Blunderprint" leads to the same 200 games; without this the print vanished with the page and another one swept in.
    - **Start:** a plain left click while the landing's print is whole (the dive's canvas says so with `data-print="x,y,width,height"`, only on the first screen once the scan has passed) copies that region into ONE fixed canvas on `<body>`. It is outside React, so the route change doesn't touch it. A click that opens a new tab, reduced motion, or a print less than 60% on screen: no carry, a plain navigation.
    - **Land:** when the dashboard's Blunderprint first paints (unfiltered only; `carry` prop), the copy moves onto its counterpart over 700 ms and fades: onto the dashboard's own print when ≥ 25% of it is on screen (a tall window), otherwise it is **pressed flat into the plate's one-line strip** (`[data-print-line]`, `Plate.tsx`): the same games on the same move axis, which is what that strip is. At 1280×900, 768 and 390 px the print starts at the bottom of the screen or below it, so the strip is the usual landing. The dashboard's print is drawn whole at once then (no sweep).
    - **A sibling's entrance is finished first** (`settledBox`: the patterns sections rise into place, and the copy needs to know where they END up).
    - **It always ends:** no dashboard print within 1.5 s (a sleeping server, another page) → the copy fades where it is; a second timer removes it if the browser runs no animation frames.
    - Only a transform and opacity on a fixed element: measured CLS 0.0000 across the click at 1280×900, 1280×1500, 768 and 390 px.
    - **Pointing at the link starts the dashboard's summary request** (`prefetchSummary`, also on focus and touch); the dashboard takes that answer instead of asking again. It is the landing's only request to the API besides the health check, and only when the link is pointed at.
  - **Link-preview picture (Stage 8 chunk D step e, 19 Nov 2026):** `src/app/opengraph-image.png` (1200×630, committed) + `opengraph-image.alt.txt`. Next serves it and writes the `og:image` / `twitter:image` tags by the file's name; `layout.tsx` sets `metadataBase` (the site's address, so the tags are absolute URLs), the Open Graph title and description, and the large Twitter card. Every page shows the same picture.
    - **Made by `npm run og:image`** (`scripts/og-image.mjs`, from `web/`, with `npm run build && npx next start -p 3000` running): the headline, and the print of all 200 snapshot games painted by the real `drawRows` (it runs in Node against a recording canvas context, and the rectangles are replayed on a real canvas in headless Chrome, with the site's own fonts). Not Next's `ImageResponse`: that renderer only knows flexbox, and the print is ~16,000 ticks.
    - **Re-run rule: after every `npm run snapshot:demo`, run `npm run og:image` too** and commit both, or the preview shows older games than the landing page.
    - The player's name is not on the picture (a shared preview shouldn't read as an endorsement). No `og:url`: set in the layout it would name the home page on every page.
    - If the site's address changes: `SITE_URL` in `layout.tsx`.
  - **Under the dive:** one line for a technical reader, each part a link to its README section: "engine in your browser · an agent with tools · code checks every claim" (the last goes to `<a name="verify">` in the README's coach section); then "The demo: Lichess · DrNykterstein · 200 public games, analysed in the browser · as of <date>. Not affiliated with the player: these are the account's public games."; then the health line.
  - **The health line is quiet** (`HealthStatus.tsx`, used only here): "API ok · DB ok" in small type; while the API wakes, "The server is waking up." with no counter (nothing on this page waits for the API). The check is still the API prewarm.
  - Data: the committed snapshot `src/data/demo.json` (`npm run snapshot:demo`; it refuses unless the player is a frozen demo player, every game analysed and the report current). Never a live fetch.
- `/p/[platform]/[username]`: dashboard. Import progress, then analysis progress, then the patterns dashboard (built in Stage 3), then the full games list (never filtered), and later a "Coach me" button.
  - **Filters** (colour, speed, played: all time / 30 days / 90 days / 1 year) live in the URL (`?color=&speed=&range=`) and are pushed with `history.pushState`, so links can be shared and the back button steps through them. The URL keeps the preset, the API gets a `from` date.
  - **Data:** `GET /summary`. The last answer stays on screen while a new filter loads, so the charts animate from the old values. Refetches when the engine stores a game or an import finishes, at most every 10 s, and keeps polling while `extracting`; none while the tab is hidden.
  - **Charts:** hand-rolled SVG, stacked by kind, errors per 100 moves (default) or per game. A bar or openings row on fewer than 5 games is greyed out with "few games".
- **Site footer (Stage 8 chunk F, `components/SiteFooter.tsx`, in `layout.tsx` so every page has it):** "Free software (AGPL) · Source · Licences". Source is the GitHub repo (the AGPL's offer of the source to visitors), Licences is `THIRD_PARTY_NOTICES.md` on GitHub. The page wrapper in `template.tsx` is at least one screen tall (`min-h-svh`), so the footer starts below the first screen: in view, a loading dashboard pushed it and measured CLS 0.026 (0.005 with the fix).
- **404 and error pages (Stage 8 chunk D step d, 19 Nov 2026).** Both use the page frame and `components/Notice.tsx` (moved out of `PlayerDashboard.tsx`; the coach page and the game review still have their own local copies).
  - `app/not-found.tsx`: "Nothing on this square." with a link to the search and one to the demo. Any unknown address and every `notFound()` call (unknown platform, impossible username, `/dev/engine` in production) gets it with HTTP 404.
  - `app/error.tsx` (a Client Component): "That was a blunder. Ours." with Try again and a link home. It shows a fixed message, never the error's text, and logs `page_error` with the error's digest to the browser console (the site has no error collector). **In Next 16.4 the prop is `retry`** (re-fetches and re-renders the page), not the older `reset`.
  - No `global-error.tsx`: it would only catch a crash in the root layout, which is fonts and metadata.
  - **Checking the error page needs a page that throws, and no real page does:** add a temporary one (e.g. `src/app/dev/boom/page.tsx`, a client component that throws), build, run `set UI_ERROR_PAGE=/dev/boom&& node scripts/ui-audit.mjs error` (and `ui-motion.mjs error`), then delete it. Never commit it. In Git Bash the path needs `MSYS_NO_PATHCONV=1`, or `/dev/boom` is rewritten to a Windows path.
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
  - **"Checked", made visible (UI pass step 5, 20 Nov 2026; `lib/checked.ts`, `coach/Checked.tsx`):**
    - The page's opening line is one sentence at reading size: "Code computed every number here from your N analysed games. The coach chose the patterns and wrote the words, and code checked each claim against the games." (it was two lines of 12 px grey).
    - **Every figure the page can place sits on a teal rule** (the answers' `figure-rule`), drawn once when its card is revealed: the big number, "vs your 3.0", each number in the coach's sentences and drill, and each board's cost.
    - **Pointing at a figure (or focusing or tapping it) says where it comes from** in one line under the explanation ("✓ 49.4 is what 47. Nd4?? lost in win chance: the outlined position."; "✓ 5.5 is this group's own rate: 80 blunders in 1,457 of your moves, over 101 games.") and outlines the board and lens row it belongs to. The figures are real buttons (keyboard, `aria-describedby` the source line). The line's height is reserved (three lines on a phone, two from `sm`): measured CLS 0.0000 with the pointer passed over all 15 figures of the demo report.
    - **How a number finds its source:** `checkedParts` ports the verifier's `proseNumbers` and `matchesValue` (a number matches a value it could be a rounding of) and looks through the fields the report carries: each cited position's win chance lost, move number and clock; the stat's value, baseline, gap and sample; the bounds in the positions' clock buckets and in the label code wrote. The words around the number choose which kind is tried first ("win-chance points" → a cost, "percent" → a bound, "move N" → a move number), an exact value beats a rounding, and two positions with the same figure are taken in the order they are mentioned.
    - **A number the page can't place stays plain text.** The report doesn't carry everything the verifier saw (the group's filter, the example search's match counts), and the page never guesses. On the demo report all 9 prose numbers are placed.
    - **A board's cost keeps its decimal** ("−49.4 pts win chance", was "−49"): the sentence above quotes 49.4, and the two must read as one number.
    - Not on the answers: an answer's figures are slots, and the page gets a slot's text and kind, not its path.

### Design direction (no "AI slop")
- **Avoid:** purple-to-blue gradients, glowing borders, glassmorphism, blurred orbs, icon-in-circle feature blocks. Also don't copy Chess.com's green or Lichess's brown boards.
- **Palette (starting point, tell me if you change it):**
  - Ink `#1B1D1A`, Bone `#E9E4D8`, Graphite `#2B2B28`, Stone squares `#D8D2C4` / `#8C8675`.
  - Classifications: inaccuracy Amber `#D4A72C`, mistake Rust `#D9772B`, blunder Brick `#B3362B`, best/good Teal `#3E7C74`.
  - **Readable text (Stage 8 chunk D step f; WCAG AA: 4.5:1 for normal text):**
    - **Grey floor:** muted text is `text-graphite/70` at the lightest (4.80:1 on bone). /60 was 3.63 and /50 was 2.81.
    - **The classification colours above are for ticks, bars, squares and arrows.** As WORDS they use darker text-only tokens (`globals.css`: `--color-best-text` `#28675F`, `--color-mistake-text` `#944902`, `--color-blunder-text` `#AD3026`; same hue and chroma in OKLCH, 5.1–5.2:1 on bone, ≥ 4.5:1 on the hover tint). Use `TEXT` / `BEST_TEXT` from `review/classes.ts`.
    - **No amber text:** darkened to 4.5:1 it is a brown that reads as the rust. An inaccuracy's words are ink behind one amber tick (`TEXT.inaccuracy` → `.tick-inaccuracy` in `globals.css`, a drawn 3 px box like a move in the Blunderprint; an underline was tried first and read as a link).
    - The darker tones are for bone and stone tints only: on ink they are ~2.6:1.
    - **Check: `node scripts/ui-contrast.mjs [base] [--shots <folder>] [page names…]`** measures every visible piece of text on the pages at 1280 and 390 px from the real computed colours. It can't see hover and focus states, text on a canvas, or a state the demo pages don't show (an error message, the trace's amber "switch" row). A lone ■ (a legend's colour sample) and disabled controls are listed, not counted.
- **Type:** Newsreader (display serif, the "chess book" feel), Geist (UI), Geist Mono (notation, numbers, the agent trace).
- **One scale (UI pass step 6, the rhythm pass, 20 Nov 2026). Use these sizes and no others:**
  - **Display (Newsreader): 60 / 36 / 24 / 20** (`text-6xl` / `4xl` / `2xl` / `xl`). A page's title is 36 on a phone and 60 from `sm` (the landing's headline, the player's name, "Coach report", the 404 and error pages); the game review's title and a section heading ("Patterns") are 24 → 36; a card's or block's title (a pattern, "Ask the coach", "Errors by", the dive's captions) is 24; a small block's title is 20.
  - **Text (Geist): 18 / 16 / 14.** A sentence is never 12 px. A caption that explains a chart is 14 px graphite (`text-sm text-graphite`), not 12 px at 70%.
  - **Mono (Geist Mono): 14 / 12.** No 10, 11 or 13 px. Big numbers are on the display sizes (a pattern's statistic 60; the plate's three numbers 24 → 36).
  - **The one exception, on purpose:** 12 px Geist stays inside controls and dense rows: the filter chips, the quiet buttons, the games list's second line, the facts line under an evidence board, and the heat board's held readout slot. At 14 px the filter row wraps at 1280 px, and the rows and the readout would outgrow the heights reserved for them (layout shift).
  - **No tracked capitals.** A small label over a block ("Pattern 1 of 3", "Exercise", "Coach", "Colour") is mono 12 in sentence case.
  - **Spacing between blocks: 32 / 48 / 64** (`gap-8` / `gap-12` / `gap-16`): 32 inside a section, 48 between a page's sections, 64 between the report's pattern cards. Every page's frame is `gap-8 px-4 py-10 sm:px-6 sm:py-16`.
- **Signature visual: the Blunderprint.**
  - Every analysed game is a thin horizontal **move ribbon**, one tick per move, coloured by classification. Only the imported player's moves are coloured; opponent ticks are faint stone.
  - Stacked, the ribbons form a fingerprint-like texture of the player's habits.
  - Beside it sits an 8×8 **heat board** of where mistakes happen.
  - Clicking a tick opens that exact position.
  - **As built (Stage 3):**
    - **Redrawn in the UI pass (20 Nov 2026, `geometry.ts` `drawRows`): a quiet line per game, a mark per error.** Each game is one pale line (`RIDGE` `#cfc8b9`) as long as the game; each of the player's errors is a coloured mark at its ply, 2 columns wide (`MARK_COLS`: its own ply and the reply's), never thinner than 2.5 px. Before, every ply was its own tick (the player's moves dark, the opponent's faint), and that alternation was the loudest thing in the picture: at 1280 px the landing's print read as grey noise. Single moves are still shown wherever ONE game is opened: the loupe, the coach's lens (`TICK_COLOR`). Anywhere on a mark is that error (`markAt`), for hover and click. The games list's per-game ribbons (`lib/ribbon.ts`) are unchanged.
    - One **canvas** (200 games × ~80 plies is ~16,000 ticks; as DOM nodes that would be slow). Rows 3 px + 1 px gap (2 + 1 on narrow screens), newest at the top. x is the ply on one scale for all rows, so a column is the same move in every game.
    - Rows are cut at **120 plies** so one long game doesn't squash the rest. A cut row gets an end marker tinted by the worst of the player's errors past the cap. The hover/tap **loupe** draws the game's full row, and its ticks can be clicked too.
    - Keyboard: ↑/↓ choose a game, ←/→ step through its errors (past the cap too), Enter opens.
    - **Heat board:** the destination square of each error. White's games on a normal board, Black's flipped, "both" with Black's ranks mirrored so rank 1 is always the player's back rank (labels say "from your side"). Until the UI pass it was a tint per square (one hue, strength = blunder 3 / mistake 2 / inaccuracy 1); redrawn below.
  - **The dashboard in the UI pass (20 Nov 2026; needs summary v3, §8.3):**
    - **The plate** (`patterns/Plate.tsx`, the first thing in the patterns section; it follows the filters): three numbers that count up (errors per 100 moves, blunders per 100 moves, average accuracy), the print pressed into one line (`digest.ts` `moveDigest`: 60 cells, how often each move number goes wrong, as a share of the busiest; a move number under 4% of the games reach stays empty), and one sentence from the API's own move-number buckets (`densest`: the bucket with the highest errors per 100 moves on ≥ 100 moves, only when it is ≥ 10% above the overall figure; else "spread evenly").
    - **The heat board is a real board** (`HeatBoard.tsx`): stone squares, coordinates in the corners, and a **brick disc** per square for the win-chance points lost there (`cost`). `heat.ts` `markOf`: the disc's AREA grows with the cost above a **baseline** (the weight 85% of the 64 squares stay under, `BASELINE_SHARE`); squares at or under it get a small dot that fades toward nothing.
      - **Why a baseline:** a strong player's errors land almost everywhere. On the demo player the 16 costliest squares are within 26% of the top one, so discs sized on the raw cost (sqrt of cost / max) came out nearly equal: a board full of dots (the prototype's "Go stones"). With few errors the baseline is 0 and the area is simply proportional to the cost.
    - **The print and the board talk** (`PrintAndBoard` in `PatternsDashboard.tsx` holds the link, so a moving pointer re-renders only those two; `link.ts`):
      - point at (focus, tap) a **square** → the print draws the errors that landed there larger with an ink edge and fades the rest (`drawRows` `emphasis`, one repaint, no resize); the readout under the board shows the square's costliest move as a position (`components/MiniBoard.tsx`) with the move played in rust and the better move in teal. A click (Enter, a second tap) opens that move in the game review.
      - point at a **mark** in the print (or step to it with the arrow keys) → the board outlines its square and the readout names the move, its cost and the game. The loupe's line also says the move and its cost ("30. Rb1?? · blunder · 19.8 points").
      - **A mark's position is only shown when it is its square's costliest move.** The summary carries one position per square (120 on the demo player), not one per error (990): that would add ~60 KB. For any other mark the small board is empty with the square tinted, and the click opens the real position.
    - **A filter change glides** (`Blunderprint.tsx`, `glideY` / `leaveAlpha` in `geometry.ts`): games that stay move to their new row over 480 ms, games that leave fade out where they were in the first half, new ones fade in. Time-based; a timer lands the final picture whether or not a frame ran; reduced motion: no glide. The canvas takes its new height at once (rows below it are simply cut).
    - **The small boards' pieces are our own copy** (`public/pieces/*.svg`, 12 files, ~13 KB together, made by `node scripts/make-pieces.mjs` from react-chessboard's set; `THIRD_PARTY_NOTICES.md`), drawn as `<img>`: importing them from react-chessboard would pull its whole drag-and-drop board (~50 KB of script) onto the dashboard. They are fetched when the browser is idle, so the first position doesn't draw piece by piece.
    - **The hydration warning the chat saw on the prototype** ("1 Issue" in dev) came from the prototype's strip only: it was rendered on the server, and an unrounded `(r / max) ** 1.4` gave a different last digit in Node and in Chrome. The real strip is drawn from fetched data in the browser and rounded to two decimals. Checked in `next dev`: the landing, dashboard and coach pages show 0 console errors.
    - **Measured, local production build on the live API:** ui-audit 0 failures (the dashboard has 285 controls, 64 of them squares), ui-motion all ok, CLS 0.002, ui-contrast AA, ui-csp no violations; the glide's frames differ until ~480 ms and are still from 510 ms.
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
Render's free API sleeps after 15 minutes. The first request can take up to about a minute. Show a "Waking the server up… (Ns)" counter after 3 seconds, the same pattern as Interview Prep. The landing page is the exception: nothing on it waits for the API, so its footer only says "The server is waking up." (no counter).

---

## 13. Security and operations (lessons from my last four projects, apply from day 1)

- **Error handler:** 5xx responses send a fixed message and log the real error. Only `err.statusCode` sets a 4xx, never `err.status` (SDK errors carry their own). If `res.headersSent` (an SSE stream failing midway), log one line (`response_failed_after_headers`, with the request ID) and cut the connection (`req.socket.destroy()`): that is what Express's default handler does after `next(err)`, but it also prints the raw stack with `console.error`, so we don't call it (Stage 8). Body-parser errors get fixed messages. Unknown `/api` routes return 404 JSON. Set an explicit body size limit.
- **Trust proxy:** read `TRUST_PROXY_HOPS` (0–5, default 0, invalid values warn and fall back to 0). On Render it must be **3** (visitor → Cloudflare → Render proxy). Set it before the rate limiters. Log a warning on Render when it's 0. Use express-rate-limit's `ipKeyGenerator` for IPv6. Tested (`routes/guards.test.ts`): with 3 hops the visitor is the third address from the right of X-Forwarded-For (a faked leftmost address is ignored); with 0 hops the header is ignored.
- **CORS:** a fixed allowlist (localhost + the live Vercel URL) plus an optional `CORS_ORIGINS` env list, parsed strictly (no `*`, no paths). Ledger broke on this when the Vercel address changed.
- **Security headers on the site (Stage 8 chunk D step c, 19 Nov 2026; `web/src/lib/securityHeaders.ts`, wired in `web/next.config.ts` `headers()` on `/:path*`):**
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. Vercel adds HSTS itself.
  - **The CSP is ENFORCED** (`Content-Security-Policy`, 19 Nov 2026). It ran as `Content-Security-Policy-Report-Only` (reports, blocks nothing) from 48156e2 through steps d, e and f with no violation on live, then was switched on. **After any change to the policy, or to what a page loads or connects to (a new API host, a font, an image host, a script), run `ui-csp.mjs` on a local production build BEFORE pushing and on live after:** a violation is now a blocked request, i.e. a broken page. To go back to Report-Only: the header's name in `securityHeaders()`.
  - The policy: `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' <API origin>; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`. Development adds `'unsafe-eval'` (React's error overlay) and leaves out `upgrade-insecure-requests` (localhost is plain http).
  - **`connect-src` takes the API origin from `NEXT_PUBLIC_API_URL` at BUILD time.** If the API ever moves, the site must be rebuilt (Vercel: redeploy), or every API call is blocked.
  - **Decision (mine, 18 Nov 2026): `'unsafe-inline'` scripts, not nonces.** Next's inline scripts would need a nonce per request, and Next's docs say every page must then be dynamically rendered; the landing page would stop being a static file. So the policy doesn't stop an injected inline script; the README says so. The app renders no HTML from outside (its one `dangerouslySetInnerHTML` is a fixed one-line script of our own, the landing's entrance flag in `HeroWords.tsx`).
  - **A worker follows the policy sent with its OWN script,** so `/engine/*` must carry the same headers (it does: one rule for every path), and `'wasm-unsafe-eval'` + `connect-src 'self'` (the worker fetches its `.wasm`) are what the engine needs.
  - **Check: `node scripts/ui-csp.mjs [base] [--engine <platform>/<username>] [--selftest]`.** Collects `securitypolicyviolation` events and the CSP console messages of the page and its workers (it attaches to each worker before it runs). `--engine` needs a STORED, NON-demo player and stores ONE analysis result (it opens only the review page, so no import starts). Safe on live: it clicks only a pre-answered chip. `--selftest` must see one page violation (a connect to 127.0.0.1:9) and one worker violation (the worker script's policy swapped for `default-src 'none'` in the browser); Chrome ignores such a swap for a page's own policy.
- **Outbound politeness:** the global serial queues for Chess.com and Lichess, the User-Agent with contact, backoff, and timeouts on every fetch.
- **Logs:** structured one-line JSON logs with a request ID, the job ID and timings. `/api/health` reports the queue depth. **Conventions (Stage 8 chunk A, `lib/logger.ts`):**
  - `msg` is a fixed snake_case event name (`job_started`, `report_done`, `ask_done`, `coach_model_error`, `fetch_retry`, `limit_refused`); values are always fields, never part of the name. `error` is the error's message (`errorMessage`), `stack` only for unexpected errors. A field named `level`, `time` or `msg` is dropped.
  - **Log context:** `withLogContext(fields, fn)` uses Node's `AsyncLocalStorage` (one value per chain of async calls): every line logged inside `fn`, however deep, gets those fields. The worker wraps each job (and its `onFailed`) in `{ jobId }`; the report and ask handlers wrap the agent run in `{ runId }`. So the importers', the agent loop's and the tools' lines carry their job and run without being handed the ids. Tested through the polite client's serial queue and with jobs running at the same time.
  - **Lines that must not carry a job's id** use `withoutLogContext`: an event's listeners run in the context of whoever emits it, so the request line of an SSE stream that a job's own `done` event ends, and Mongoose's connection events (the pool can open a socket during a job), would otherwise be stamped with that job. Every long-lived queue, timer and cache (pacer, polite clients, storage gate, flood guard store) is created at startup, outside any job; per-job timers end with the job (checked 18 Nov 2026).
  - **Requests don't use the context** (Express's body parser continues from socket events outside it): a log inside a request handler passes `requestId: res.locals.requestId` itself.
  - **The request line** is written on `finish`, or on `close` with `aborted: true` when the visitor closed the connection first (a closed SSE stream used to leave no line). The query string is never logged (an ask run's token travels in it).
  - **Uncaught errors** (`lib/processErrors.ts`): an unhandled promise rejection or an uncaught exception logs one line (`unhandled_rejection` / `uncaught_exception`, with the stack) and runs the graceful shutdown below with exit code 1, so the running job is released and Render restarts the service. A server `error` (port taken) logs `server_error` and exits 1. Mongoose connection errors log `mongo_error`.
  - Still free text in the logs, on purpose: Google's error message (200 characters) and the model's unshown `notEnoughData` text (200 characters). Public chess usernames appear in request paths, job keys and importer URLs.
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
GEMINI_THINKING_INVESTIGATE=  # Stage 8 chunk H: thinking level of the MAIN model's tool-calling calls + repair round
GEMINI_THINKING_ANSWER=       # ... and of its answer call. minimal|low|medium|high|xhigh; unset = send nothing (today: unset)
AI_ENABLED=true
AI_DAILY_CALL_BUDGET=400
GEMINI_RPM=15 GEMINI_TPM=250000 GEMINI_RPD=500   # the free-tier limits from AI Studio (pacer + warning)
COACH_MODEL=gemini      # "scripted" = the fake coach for local development (refused in production)
COACH_SCRIPTED_SCENARIO=ok  # dev only: ok | overload-switch | fail-overloaded | slow | out-of-credit (refused in production)
COACH_MAX_MODEL_CALLS=10 COACH_MAX_REPAIR_CALLS=2 COACH_MAX_REQUESTS=16 COACH_MAX_TOKENS=120000
COACH_CALL_TIMEOUT_MS=60000 COACH_RUN_TIMEOUT_MS=300000
COACH_MIN_BASELINE_GAP=0.15 COACH_MIN_CANDIDATE_GAMES=5 COACH_MIN_CANDIDATE_MOVES=100
COACH_MIN_ANALYSED_GAMES=20
CORS_ORIGINS=           # optional extra origins
TRUST_PROXY_HOPS=       # 3 on Render, unset locally
CONTACT_EMAIL=          # used in the User-Agent for Chess.com/Lichess
MAX_GAMES_PER_PLAYER=200
DEMO_PLAYERS=           # e.g. lichess:DrNykterstein: frozen (no re-import, no claims), trace kept, never evicted; invalid entry stops startup
IP_HASH_SALT=           # Stage 6: secret key of the visitor hash; ≥ 32 random chars, required in production
LIMIT_IMPORTS_PER_HOUR=5 LIMIT_IMPORTS_PER_DAY=15 LIMIT_REPORTS_PER_DAY=3
LIMIT_REQUESTS_PER_MINUTE=300   # flood guard
STORAGE_NEW_PLAYER_LIMIT_MB=120 NEW_PLAYERS_PER_DAY=40 IMPORT_QUEUE_MAX=10
STORAGE_EVICT_TO_MB=100         # Stage 8: at the gate, evict in the background down to this (§7)
LIMIT_ASKS_PER_HOUR=6 LIMIT_ASKS_PER_DAY=20 COACH_QUEUE_MAX=5               # Stage 6 chunk B
ASK_MAX_MODEL_CALLS=6 ASK_MAX_REPAIR_CALLS=1 ASK_MAX_REQUESTS=10 ASK_RUN_TIMEOUT_MS=120000
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
| **6. Ask + guards** (chunk A guards ✅ 11 Nov 2026, 259eca3; chunk B ask backend ✅ 12 Nov 2026, 37d6d0e; chunk C ask UI + demo pre-answers ✅ 12 Nov 2026, 7b869f8, 3fd4384, 877db29; chunk D: ops:status 6d83254, live drills 12 Nov 2026, README rewrite 18 Nov 2026, c11485d) | Follow-up questions, per-IP limits, global AI budget, kill switch, demo players pre-analysed | Recruiter can ask follow-ups safely | Budget exhaustion shows the friendly message; demo players never evicted |
| **7. Landing + animation pass** ✅ done 7 Nov 2026 (frozen demo players 62c9a96, landing 97cf88e, animation pass c721a72, perf probe + parallel summary 2f2456f, perf fixes in the "perf: no layout shift on the dashboard…" commit) | Landing page, motion polish everywhere, reduced-motion support | The full 60-second demo | Smooth on my laptop with dev tools closed |
| **8. Hardening + README** (chunk A logs + process safety ✅ 4613b59; chunk G CI ✅ 23fa3a7, eb97a8a; chunk B games list in one request ✅ a480478; chunk C tests ✅ 18 Nov 2026: 68995a2, add8fe5, 758ccb5 (CI races), 8f0570b, e76cb78; backend 612 → 645 tests, web 195 → 257. Chunk D web hardening, in steps: a Next.js 16.4.6 ✅ 829f93f; b the games list's render ✅ 6bc1b06; c security headers, CSP in Report-Only ✅ 48156e2; d 404 + error pages ✅ 751a62d; e link-preview picture ✅ 82d81c1; f readable text (WCAG AA contrast) ✅ 91cc819; the CSP enforced ✅ 19 Nov 2026. Chunk D done. Chunk F licences (AGPL-3.0-or-later, THIRD_PARTY_NOTICES.md, footer) ✅ c6469ac. Chunk E storage eviction at the gate (`lib/eviction.ts`, §7) built 20 Nov 2026 ✅ 8a4a935. Chunk H1 (402 handling + refund, thinking settings, colour rule, prompts v7; on today's free model) built 20 Nov 2026 ✅ 1838925; H1.1 (field names in prose, intensity before an error kind, prompts v8) 20 Nov 2026. H2 (paid tier: privacy note, README, model switch) waits for billing: checklist in §10 Guards) | Tests for all core logic, structured logs, README (architecture, decisions, numbers, demo GIF), then the one-off AI credit with a spending cap (done through the Claude.ai chat). Credits and licences (done in chunk F): the Stockfish GPL-3.0 credit (README + `/engine/Copying.txt`, `SOURCE.txt`), react-chessboard's piece set (Colin M.L. Burnett's, used under BSD), and the repo's own licence (AGPL-3.0-or-later; lila, which the classification is ported from, is AGPL too). Update the Ask privacy note once the paid Gemini tier is on (H2, §10). Unverifiable colour ("cost you the game") is a prompt rule and a verifier check since chunk H1 (§10) | Portfolio-ready | Everything in section 16 has a fallback in place |

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
| Abuse (someone imports thousands of users) | Low | Storage and quota drain | Per-IP limits, the storage gate and eviction, max games per player |
| GPL-3.0 engine code in the repo | Certain | Licence obligation | Keep the repo public, ship Stockfish's licence file, credit it in the README. Since Stage 8 chunk F the repo is AGPL-3.0-or-later (`LICENSE`), the footer on every page links to the source, and `THIRD_PARTY_NOTICES.md` lists every third-party work: **add a new dependency, port, font or asset there, with the licence read from its source**. Not legal advice: keep it simple and open |
| Scope creep (accounts, puzzles, multiplayer…) | High | Never finished | Out of scope until Stage 8 is done (section 18) |

---

## 17. Known gotchas

- **Gemini model names** get deprecated faster than published dates suggest. `gemini-3.5-flash` was retired on 8 Oct 2026. Keep the model in env and verify it before Stage 5. Don't confuse the retired `gemini-3.5-flash` with `gemini-3.5-flash-lite` (current; no shutdown date announced as of 30 Oct 2026). `gemini-3.1-flash-lite` shuts down on 7 May 2027. Google's Gemini docs moved to aistudio.google.com/docs (the old ai.google.dev/gemini-api/docs pages redirect), and the free-tier limits are no longer published there: read them in AI Studio.
- **Local dev and the shared Atlas DB:** a local API with `COACH_MODEL=scripted` writes reports under model `scripted` and counts its budget under `dev:scripted`, and its coach lane only claims `scripted` report jobs, so it never touches the live coach's reports, budget or jobs.
- **`/api/health` `version` never changes** (it's package.json's 0.1.0). The deploy is `commit`: the first 7 characters of `RENDER_GIT_COMMIT`, which Render sets at build time AND runtime ("The commit SHA for a service or deploy", render.com/docs/environment-variables, checked 12 Nov 2026); `"dev"` when unset.
- **Known quirk: "resting" for reports while questions still work.** GET /report's `ai.canStart` compares the budget with one worst-case REPORT (`COACH_MAX_REQUESTS`, 16), but POST /ask only needs `ASK_MAX_REQUESTS` (10). With 10-15 calls left the coach button says the coach is resting while the question box still sends. Correct on both sides, just inconsistent to look at; the question box isn't disabled by the budget (a refused question shows "The coach is resting").
- **Thought steps and the fallback model (unknown, Stage 8 chunk H):** the loop sends every model step back as it came, thought signatures included. After an overload switch the FALLBACK model therefore receives thought steps the main model wrote. Never seen failing (flash-lite barely thinks), but not verified with `gemini-3.8-flash` → `gemini-3.1-flash-lite`: check it in H2 (§10); if Google rejects it (a 400 → `coach_config`), strip thought steps on the switch.
- **A prompt bump makes every stored report and answer stale** (chunk H1's v7 and H1.1's v8 did; the H2 model change will again): the demo report shows "an updated coach is available" until my Refresh click, and the demo chips are unanswered unless `demo:answers` was run for the new version BEFORE the push (the H1 order).
- **Demo pre-answers go stale** on every `ASK_PROMPT_VERSION` bump or `GEMINI_MODEL` change (both are in the answer cache key): re-run `npm run demo:answers` against live with `GEMINI_MODEL` set explicitly, then update `DEMO_ANSWERS_PROMPT_VERSION` (§10). Until then a visitor's demo chip click spends real AI calls.
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
- **CI (GitHub Actions, `.github/workflows/ci.yml`):** `actions/checkout@v7` and `actions/setup-node@v7` (the latest majors, read from their release pages on 18 Nov 2026); the runner is pinned to `ubuntu-24.04` (eb97a8a) only so it doesn't change under us: GitHub began moving `ubuntu-latest` to Ubuntu 26 on 19 Oct 2026. The tests' MongoDB 8.0.34 (mongodb-memory-server) ran fine on both. setup-node only caches npm when asked (`cache: npm` + `cache-dependency-path`, because there is no root package.json). The web typecheck is `next typegen && tsc --noEmit`: `PageProps`/`LayoutProps` are generated types (`.next/types`, `next-env.d.ts`, both gitignored), so a plain `tsc` fails on a fresh checkout. The backend has no linter (only `web/` has ESLint).
- **The first red CI runs were a race in our own tests, not the runner** (read from the logs with `gh run view <id> --log-failed`, 18 Nov 2026). Runs 44273990041 (23fa3a7, on ubuntu-26.04, 610 of 611 passed), 44278232122 (68995a2) and 44289025940 (add8fe5) all failed in `routes/coach.test.ts`: a test read the report job right after the run stream's last event and found it still `running`, because the worker marks a job done or failed just AFTER its handler returns. My laptop always won that race; GitHub's slower runner sometimes lost it. I first blamed MongoDB on Ubuntu 26, because the run after the pin happened to be green: wrong, and only the log showed it.
  - **Fix (758ccb5, with add8fe5):** in `coach.test.ts` and `ask.test.ts`, `streamAll` waits after `done`/`failed` until the run's job has settled (`jobSettled`), and tests that read the job use `jobDone()` / `finishedJob()`. Checked locally with the worker's completion slowed by 300 ms (620 of 620 passed), then on CI: run 44293068728 green 4 times in a row (the first run and 3 re-runs).
  - **The rule for new tests:** a stream's `done` event means the RUN is finished, not the JOB. Wait for the job before reading it or before asking the route for the next run (an active job means "202, the same run").
  - **A second flaky test, found by a local run failing (18 Nov 2026):** the ask-token test built its "wrong" token by replacing the last character with `0`; one token in 16 already ends in 0, so the wrong token was the right one and the stream answered 200. Not a product bug. The test now changes the last character to a different one (`wrongLastChar`).
  - **`gh` is installed** at `C:\Program Files\GitHub CLI\gh.exe` (logged in); when CI is red, read the failed log before guessing.
- **Lighthouse on the dashboard after "one request" (18 Nov 2026, 5 mobile runs on live):** median score 78, LCP 4.0 s, TBT 379 ms, CLS 0 (runs: 65 / 78 / 76 / 79 / 81; TBT 275–529 ms). The baseline was 78–79, 4.0–4.2 s, 330–340 ms, 0: the score is unchanged and TBT a little higher, inside the spread. Measured with the CPU slowed 4× on the page's own clock: the longest frame (559–826 ms, of which React's render 245–343 ms and style/layout/paint 280–478 ms) starts right after the games response, so it IS the 200 rows rendering in one go (before chunk B they arrived as four batches of 50). Unthrottled it is one 90–95 ms frame. Not changed: the median isn't clearly worse. If it ever matters, the lever is rendering the first screen of rows first and the rest in a later task. Lighthouse isn't installed in the repo: `npx lighthouse <url> --only-categories=performance --form-factor=mobile` with `CHROME_PATH` set.
- **The games list's render frame, fixed (Stage 8 chunk D step b, 19 Nov 2026).** Two changes in `GamesList.tsx`:
  - **`content-visibility: auto` on every row** (the browser skips layout and paint of off-screen rows) with `contain-intrinsic-size: auto 74px` (two-line rows) / `auto 56px` from `sm`. That size is the row's CONTENT height: its 1 px border comes on top (rows are 75 / 57 px), and a first try with 75 made every skipped row 1 px too tall.
  - **First rows first** (`lib/firstRows.ts`): a list that has just arrived renders 30 rows at once and the rest through React's `useDeferredValue` (a later render React can interrupt). A refreshed list never shows fewer rows than were already drawn.
  - **Measured** (`node scripts/ui-games-frame.mjs [base] [loads]`: demo dashboard, 412×823, CPU 4×, the longest frame after the games response, 7 loads each, same hour): before (live) 493–760 ms, median **656 ms**; after (local production build on the live API) 107–228 ms, median **173 ms**. Lever 1 alone removed the paint spikes (interleaved A/B on one build: rendering 1–2.5 s on bad loads → ≤ 260 ms) but left React's render, so both were needed.
  - **The measurement is noisy on my laptop:** the same page gave 350 ms and 2.9 s minutes apart when something else was using the CPU. Compare before and after in the same sitting, with 7 loads, never against an old number.
  - **`content-visibility` clips what a row paints outside its box,** so the usual focus ring (2 px OUTSIDE the link) vanished on the rows: found in a screenshot, not by the computed style (which still said "solid 2px"). The rows' links use `.focus-inset` (`globals.css`: the ring 2 px inside). It's a plain CSS rule because the global `:focus-visible` rule is unlayered and beats any Tailwind utility (`focus-visible:-outline-offset-2` did nothing).
  - Checked at 1280 and 390 px: rows 30 → 200, the reveal animation, one row height on and off screen, the page height unchanged over a scroll to the bottom, Tab onto an off-screen row (scrolled in, ring visible), find-in-page for a row far down, a live ribbon filling on a non-demo dashboard, ui-audit 0 failures, CLS 0.005.
- **`npm audit` in `web/` after Next 16.4.6 (19 Nov 2026): 15 findings left (6 moderate, 9 high), all lint-time dev dependencies** (picomatch GHSA-fc5q-39xc-vjpf and minimatch GHSA-g3hv-75wg-m249, under eslint-config-next / typescript-eslint / tinyglobby). None ships to the browser or runs on Vercel at request time. npm's `audit fix --force` would downgrade eslint-config-next to 14: don't take it.
- **Coverage numbers** (Node's built-in, `--experimental-test-coverage`; add `--test-coverage-exclude="src/**/*.test.ts"` or the "all files" line counts the test files too): 18 Nov 2026, source only: backend 99.17% lines / 92.26% branches / 95.86% functions; web 95.55 / 92.62 / 90.41. It only counts files a test loads: the React components and hooks aren't in the web figure.
- **Never commit `.claude/`.**

---

## 18. Scope guard (not in v1)

Accounts or sign-in, saving favourites, puzzles generated from mistakes, multiplayer, live games, mobile app, multiple languages. Each is a good "next" idea for the README's roadmap, after Stage 8.
