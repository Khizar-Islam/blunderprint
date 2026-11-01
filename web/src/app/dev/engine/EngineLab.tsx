"use client";

import { useRef, useState } from "react";
import { analyseGame, type AnalysisResult } from "@/engine/analyseGame";
import { replayPgn } from "@/engine/replay";
import { StockfishEngine } from "@/engine/stockfish";
import type { WhiteEval } from "@/engine/uci";

const SAMPLE_PGN = `[Event "Sample"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

const NODE_BUDGETS = [50_000, 100_000, 200_000];
const fmt = (e: WhiteEval) => ("mate" in e ? `#${e.mate}` : (e.cp / 100).toFixed(2));

export function EngineLab() {
  const [pgn, setPgn] = useState(SAMPLE_PGN);
  const [nodes, setNodes] = useState(100_000);
  const [evals, setEvals] = useState<WhiteEval[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [status, setStatus] = useState("idle");
  const abortRef = useRef<AbortController | null>(null);

  async function run() {
    const replay = replayPgn(pgn, Number.MAX_SAFE_INTEGER); // any count: we only want the moves
    const plies = replay.ok ? replay.moves.length : (replay.atPly ?? 0);
    abortRef.current = new AbortController();
    setEvals([]);
    setResult(null);
    setStatus("loading engine…");
    const engine = new StockfishEngine();
    try {
      const t0 = performance.now();
      await engine.init();
      setStatus(`engine ready in ${Math.round(performance.now() - t0)} ms, analysing…`);
      const r = await analyseGame(
        engine,
        { id: "lab", pgn, plies },
        { nodes, signal: abortRef.current.signal, onPly: (_, e) => setEvals((prev) => [...prev, e]) },
      );
      setResult(r);
      setStatus(
        "error" in r
          ? `can't replay: ${r.error}`
          : `done: ${r.moves.length} plies in ${(r.durationMs / 1000).toFixed(1)} s ` +
              `(${Math.round(r.durationMs / (r.moves.length + 1))} ms per position)`,
      );
    } catch (err) {
      setStatus(`stopped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      engine.terminate();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <textarea
        value={pgn}
        onChange={(e) => setPgn(e.target.value)}
        rows={8}
        className="rounded border border-ink/30 bg-transparent p-2 font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          Nodes per position
          <select value={nodes} onChange={(e) => setNodes(Number(e.target.value))} className="btn-quiet">
            {NODE_BUDGETS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={run} className="btn-quiet">
          Analyse
        </button>
        <button type="button" onClick={() => abortRef.current?.abort()} className="btn-quiet">
          Stop
        </button>
        <span className="font-mono text-graphite/80" data-testid="lab-status">
          {status}
        </span>
      </div>
      <ol className="grid grid-cols-4 gap-x-4 font-mono text-xs sm:grid-cols-8">
        {evals.map((e, i) => (
          <li key={i}>
            {i + 1}. {fmt(e)}
            {result && !("error" in result) && result.best[i] === result.moves[i] ? " ✓" : ""}
          </li>
        ))}
      </ol>
      {result && (
        <details>
          <summary className="cursor-pointer text-sm">Result body (what the API would receive)</summary>
          <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(result)}</pre>
        </details>
      )}
    </div>
  );
}
