# Blunderprint

Enter any Chess.com or Lichess username, and Blunderprint imports the games, finds the mistakes with a chess engine running in your browser, compares your positions against millions of real games, and then an AI coach agent investigates the data with tools and explains your *recurring* weaknesses, with evidence from your own games.

Work in progress.

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

## Licences

Blunderprint ships [Stockfish](https://github.com/official-stockfish/Stockfish) through [stockfish.js](https://github.com/nmrugg/stockfish.js) (v19.0.1, unmodified), which are licensed under the **GNU GPL v3**. The engine files are copied from the npm package at build time and served from `/engine/`, together with the licence text (`/engine/Copying.txt`) and a note on where their source code is (`/engine/SOURCE.txt`).
