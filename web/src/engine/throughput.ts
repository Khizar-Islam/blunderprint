// Effective time per game for the analysis bar: wall-clock time spent analysing, divided by the
// games finished. With 2 engines working side by side this is about half of what one engine
// takes per game (measured: ~20 s per engine, ~10 s effective), which is what a visitor waits.
// Time while paused, idle or waiting for another tab doesn't count.
export class Throughput {
  private runningMs = 0;
  private since: number | null = null;
  private finished = 0;

  // Call on every state change; `now` in ms (performance.now()).
  setRunning(running: boolean, now: number): void {
    if (running && this.since === null) this.since = now;
    if (!running && this.since !== null) {
      this.runningMs += now - this.since;
      this.since = null;
    }
  }

  // Call when a game's result is stored. Returns seconds per game so far, or null until there
  // are 2 games: the first one finishes before the other engine's first game does, so a single
  // game would show one engine's time, not the effective rate.
  gameFinished(now: number): number | null {
    this.finished++;
    return this.secondsPerGame(now);
  }

  secondsPerGame(now: number): number | null {
    if (this.finished < 2) return null;
    const ms = this.runningMs + (this.since !== null ? now - this.since : 0);
    return ms / 1000 / this.finished;
  }
}
