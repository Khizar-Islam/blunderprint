"use client";

import { API_URL, fetchHealth } from "@/lib/api";
import { useWakingRequest } from "@/lib/useWakingRequest";

export function HealthStatus() {
  const { state, elapsedMs, waking, retry } = useWakingRequest(fetchHealth);

  // A build-time config mistake, not a network problem: no point retrying.
  if (!API_URL) {
    return (
      <p className="font-mono text-sm font-semibold text-ink" role="status">
        NEXT_PUBLIC_API_URL is not set
      </p>
    );
  }

  return (
    <div className="font-mono text-sm" role="status" aria-live="polite">
      {state.kind === "loading" && (
        <p className="text-graphite/70">
          {waking ? `Waking the server up… (${Math.floor(elapsedMs / 1_000)}s)` : "Checking the API…"}
        </p>
      )}

      {state.kind === "done" && (
        // Ink and graphite only: the classification colours are reserved for move classifications.
        // "DB down" is set apart by weight and an underline instead of colour.
        <p>
          <span className="text-ink">API ok</span>
          <span className="px-2 text-graphite/50">·</span>
          {state.value.db ? (
            <span className="text-ink">DB ok</span>
          ) : (
            <span className="font-semibold text-ink underline decoration-ink/40 underline-offset-2">DB down</span>
          )}
          <span className="pl-3 text-graphite/50">v{state.value.version}</span>
        </p>
      )}

      {state.kind === "error" && (
        <p className="flex items-center gap-3">
          <span className="font-semibold text-ink">{state.error.message}</span>
          <button type="button" onClick={retry} className="btn-quiet">
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
