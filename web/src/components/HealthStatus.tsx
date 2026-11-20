"use client";

import { API_URL, fetchHealth } from "@/lib/api";
import { useWakingRequest } from "@/lib/useWakingRequest";

// The landing page's last line: one small, calm status. The check is made as the page loads, so
// a sleeping API starts waking before the visitor's first click; but nothing on that page waits
// for the API, so a sleeping server is said in a few words, with no counter (the pages that do
// wait show "Waking the server up… (Ns)" themselves).
export function HealthStatus() {
  const { state, waking, retry } = useWakingRequest(fetchHealth);

  // A build-time config mistake, not a network problem: no point retrying.
  if (!API_URL) {
    return (
      <p className="px-1 font-mono text-xs font-semibold text-ink" role="status">
        NEXT_PUBLIC_API_URL is not set
      </p>
    );
  }

  return (
    // The line's height is held while there is nothing to say.
    <div className="min-h-5 px-1 font-mono text-xs" role="status" aria-live="polite">
      {state.kind === "loading" && waking && <p className="text-graphite/70">The server is waking up.</p>}

      {state.kind === "done" && (
        // Ink and graphite only: the classification colours are reserved for move classifications.
        // "DB down" is set apart by weight and an underline instead of colour.
        <p>
          <span className="text-ink">API ok</span>
          <span className="px-2 text-graphite/70">·</span>
          {state.value.db ? (
            <span className="text-ink">DB ok</span>
          ) : (
            <span className="font-semibold text-ink underline decoration-ink/40 underline-offset-2">DB down</span>
          )}
          <span className="pl-3 text-graphite/70">v{state.value.version}</span>
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
