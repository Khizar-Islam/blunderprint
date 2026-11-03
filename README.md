# Blunderprint

Enter any Chess.com or Lichess username, and Blunderprint imports the games, finds the mistakes with a chess engine running in your browser, compares your positions against millions of real games, and then an AI coach agent investigates the data with tools and explains your *recurring* weaknesses, with evidence from your own games.

Work in progress.

## What it does now (Stage 3)

- **Import:** type a Chess.com or Lichess username and the newest 200 games stream in live over Server-Sent Events. Re-imports are idempotent and fetch only what's new.
- **Analysis in your browser:** Stockfish 19 runs on the visitor's own machine (details below). Each game's move ribbon fills tick by tick as the engine works, and the bar shows the measured speed ("~N s per game").
  - Desktop starts by itself, with Pause/Resume. Phones get an "Analyse on this device" button, because the engine uses the battery.
  - Only one tab per browser runs engines (a Web Lock). A second tab waits and takes over when the first closes.
- **Move classification on the server:** Lichess's win-percentage formula and thresholds (inaccuracy / mistake / blunder). On 276 real Lichess games, it matched all 3,212 of Lichess's own judgements. Games imported from Lichess with analysis keep Lichess's evals and skip the engine.
- **Game review page** (`/p/[platform]/[username]/game/[id]`):
  - Board, an eval graph that draws itself (click or drag to jump to a move), and a move list coloured by classification that scrolls to the current move. Arrow keys and Home/End step through the game.
  - On a mistake: "Nxe5?? was a blunder. Better was Nf3", with a **Show** control (click, press-and-hold, or hold B). It shows the position before the move, with an arrow for the better move and one for the move played.
  - A game that isn't analysed yet is analysed first, on one engine.
- **Patterns dashboard** (on the player page), filtered by colour, speed and date (filters live in the URL):
  - **The Blunderprint:** every analysed game as one row, one tick per move, the player's errors in colour. Hover shows the whole game larger; click opens the review at that move (`?ply=N`).
  - **Heat board:** where the costly errors land (blunders count most), for White, Black, or both seen from the player's side.
  - **Charts:** errors by phase, clock left, move number and speed, per 100 moves or per game, and the openings table. Bars built on fewer than 5 games are greyed out.
- **Free-tier cold starts:** pages show "Waking the server up… (Ns)" while the sleeping API starts.

Tests (3 Nov 2026): backend 226 passing, web 104 passing (`npm test` in each folder).

## The engine runs in your browser

The server is on a free tier whose CPU is far too slow for Stockfish, so each visitor's browser analyses the games instead. The server hands out games on a lease (`POST /api/analysis/claim`), checks every result it gets back, and classifies the moves itself.

- **Engine:** Stockfish 19 (stockfish.js, lite single-threaded WASM build, ~1.8 MB), in 1–2 Web Workers: 2 on machines with 4+ cores, 1 otherwise.
- **Budget:** a fixed **100,000 nodes per position**, not a time limit, so the cost per position is predictable and the result is the same on fast and slow machines.
- **One tab at a time:** a Web Lock means only one Blunderprint tab per browser runs engines. A closed tab hands its unfinished games back with `navigator.sendBeacon`, and if even that is lost, the 10-minute lease frees them.

### Measured (1 Nov 2026, Chrome on my laptop, 8 GB RAM)

| Setup | Per position | Per game |
|---|---|---|
| 1 engine, 50k nodes (33-ply test game) | 75 ms | 2.5 s |
| 1 engine, **100k nodes** (33-ply test game) | 152 ms | 5.2 s |
| 1 engine, 200k nodes (33-ply test game) | 300 ms | 10.2 s |
| **2 engines, 100k nodes** (6 real blitz/bullet games, 101–132 plies) | 156–203 ms, average 181 | 18.9–21.4 s each, average 20.2 s |

Running two engines side by side slows each by about 19%, but finishes about 1.7× as many games: roughly one 111-ply game every 10 s. A typical 80-ply game takes about 12 s on one engine.

## Patterns: how the numbers are made (Stage 3)

After a game is analysed, a per-player `extract` job turns it into features: each error's phase, square, clock and any piece lost, plus how many moves the player made in each phase (so rates are per 100 moves). One MongoDB aggregation (`$facet`) then builds every breakdown the dashboard shows, in one pass over at most 200 games. The unfiltered result is cached on the player; filtered views run live.

### Measured (3 Nov 2026)

- **Game phases:** the port of Lichess's `Divider` agreed with Lichess's own phase boundaries on **200 of 200** real games.
- **Index use** (`.explain()`, lichess:DrNykterstein, saved in `docs/explain/`): an index scan on `{ playerId, playedAt, _id }`, no collection scan, no in-memory sort.

| Query | Keys examined | Docs examined | Server time |
|---|---|---|---|
| Unfiltered (200 games, 170 analysed) | 200 | 200 | 36 ms |
| White + bullet + since 1 Jan 2025 (43 games) | 91 | 91 | 12 ms |

- **On Render's free tier:**
  - Feature extraction: 145 games in 28 s. About 302 ms a game for the first (cold) batch, then 135–220 ms a game, including the database write.
  - The summary route, timed from the browser: 110–117 ms cached, 128–136 ms filtered.
  - Render's edge compresses with Brotli: 46 KB of JSON becomes 7.1 KB on the wire.

## Licences

Blunderprint ships [Stockfish](https://github.com/official-stockfish/Stockfish) through [stockfish.js](https://github.com/nmrugg/stockfish.js) (v19.0.1, unmodified), which are licensed under the **GNU GPL v3**. The engine files are copied from the npm package at build time and served from `/engine/`, together with the licence text (`/engine/Copying.txt`) and a note on where their source code is (`/engine/SOURCE.txt`).
