"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { claimAnalysis, postAnalysisResult, releaseAnalysis, type MoveClass, type Platform } from "@/lib/api";
import { AnalysisScheduler, type LockManagerLike, type SchedulerEvent, type SchedulerState } from "./scheduler";
import { StockfishEngine } from "./stockfish";
import { Throughput } from "./throughput";

// The React side of the browser engine: one AnalysisScheduler per player page.
//
// - Desktop (fine pointer, wide screen): starts by itself, with a Pause button.
// - Phones: waits for "Analyse on this device", because the engine drains a battery.
// - pagehide: the scheduler hands its games back with a beacon. If the page comes back from
//   the back/forward cache (pageshow with persisted = true), we start again unless paused.

// What a row needs while its game is being analysed, or right after.
export interface LiveGame {
  plies: number;
  evaluated: number; // plies with an eval so far
  classifications?: MoveClass[]; // set when the server has classified the result
  unanalysable?: boolean;
}

export interface AnalysisView {
  state: SchedulerState;
  paused: boolean; // the visitor paused (or hasn't started yet on a phone)
  needsTap: boolean; // phone and never started: show "Analyse on this device"
  live: Record<string, LiveGame>;
  doneThisSession: number;
  secondsPerGame: number | null; // effective: analysing time / games finished (see Throughput)
  error: string | null;
  resume: () => void;
  pause: () => void;
  kick: () => void; // "there may be new games": claims again if idle (no-op when paused)
}

// useSyncExternalStore reads a value that lives outside React (here a CSS media query) and
// re-renders when it changes. On the server there is no screen: assume a phone, so nothing
// starts before the browser has had its say.
const DESKTOP_QUERY = "(pointer: fine) and (min-width: 640px)";
const subscribeDesktop = (onChange: () => void) => {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};
const isDesktop = () => window.matchMedia(DESKTOP_QUERY).matches;
const notDesktop = () => false;

// What the visitor chose. "auto" = they haven't touched the button: run on desktop only.
type Choice = "auto" | "paused" | "resumed";

// prefer: a game id to claim first (the game review page asks for the game it shows).
// engines: how many to run; default 1–2 by CPU cores. The review page wants one game, so one.
export function useAnalysis(
  platform: Platform,
  username: string,
  enabled: boolean,
  { prefer, engines }: { prefer?: string; engines?: number } = {},
): AnalysisView {
  const [state, setState] = useState<SchedulerState>("stopped");
  const [choice, setChoice] = useState<Choice>("auto");
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, notDesktop);
  const paused = choice === "paused" || (choice === "auto" && !desktop);
  const needsTap = choice === "auto" && !desktop;
  const [live, setLive] = useState<Record<string, LiveGame>>({});
  const [secondsPerGame, setSecondsPerGame] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scheduler = useRef<AnalysisScheduler | null>(null);
  const pausedRef = useRef(true);
  const throughput = useRef(new Throughput());

  const onEvent = useCallback((e: SchedulerEvent) => {
    switch (e.type) {
      case "state":
        setState(e.state);
        throughput.current.setRunning(e.state === "running", performance.now());
        if (e.state === "running") setError(null);
        break;
      case "game-start":
        setLive((prev) => ({ ...prev, [e.gameId]: { plies: e.plies, evaluated: 0 } }));
        break;
      case "ply":
        setLive((prev) => {
          const g = prev[e.gameId];
          return g ? { ...prev, [e.gameId]: { ...g, evaluated: e.ply } } : prev;
        });
        break;
      case "game-done": {
        setSecondsPerGame(throughput.current.gameFinished(performance.now()));
        setLive((prev) => {
          const g = prev[e.gameId];
          return g ? { ...prev, [e.gameId]: { ...g, evaluated: g.plies, classifications: e.classifications } } : prev;
        });
        break;
      }
      case "game-unanalysable":
        setLive((prev) => {
          const g = prev[e.gameId];
          return g ? { ...prev, [e.gameId]: { ...g, unanalysable: true } } : prev;
        });
        break;
      case "game-lost":
        // Another tab finished it; drop our half-filled ribbon, the list shows the stored state.
        setLive((prev) => {
          const rest = { ...prev };
          delete rest[e.gameId];
          return rest;
        });
        break;
      case "error":
        setError(e.message);
        break;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const s = new AnalysisScheduler({
      api: {
        claim: (prefer, signal) => claimAnalysis(platform, username, prefer, signal),
        postResult: (claimId, result) => postAnalysisResult(claimId, result),
        release: (claimId, gameIds, options) => releaseAnalysis(claimId, gameIds, options),
      },
      createEngine: () => new StockfishEngine(),
      onEvent,
      prefer,
      ...(engines ? { engines } : {}),
      locks: (navigator.locks as LockManagerLike | undefined) ?? null,
      onPageHide: (handler) => {
        window.addEventListener("pagehide", handler);
        return () => window.removeEventListener("pagehide", handler);
      },
    });
    scheduler.current = s;
    // A new scheduler for another player starts if the visitor hadn't paused. On the very first
    // render pausedRef is still true here, and the effect below does the first start.
    if (!pausedRef.current) s.start();

    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted && !pausedRef.current) s.start();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      void s.stop(); // leaving the page: hand the games back with a normal request
      scheduler.current = null;
    };
  }, [enabled, platform, username, onEvent, prefer, engines]);

  // Run or stop to match the choice. Declared after the effect above, so on the first render
  // the scheduler exists by the time this runs (effects run in order).
  useEffect(() => {
    pausedRef.current = paused;
    if (!enabled) return;
    if (paused) void scheduler.current?.stop();
    else scheduler.current?.start();
  }, [enabled, paused]);

  const resume = useCallback(() => setChoice("resumed"), []);
  const pause = useCallback(() => setChoice("paused"), []);

  const kick = useCallback(() => {
    if (!pausedRef.current) scheduler.current?.start();
  }, []);

  const doneThisSession = Object.values(live).filter((g) => g.classifications).length;

  return { state, paused, needsTap, live, doneThisSession, secondsPerGame, error, resume, pause, kick };
}
