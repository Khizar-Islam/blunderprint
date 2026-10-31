"use client";

import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useState } from "react";
import { PLATFORM_NAMES, type Platform, type PublicJob } from "@/lib/api";
import type { StreamConnection } from "@/lib/useJobStream";

// A rate-limit wait (429) happens inside the importer: the job stays "running" and the stream
// goes quiet for up to a minute. After this long without an event we say so.
const QUIET_HINT_AFTER_MS = 20_000;

// A number that counts up to `value` instead of jumping (motion animates a MotionValue and we
// render its rounded value). With reduced motion, MotionConfig makes this instant.
function TickingNumber({ value }: { value: number }) {
  const count = useMotionValue(value);
  const rounded = useTransform(count, (v) => Math.round(v));
  useEffect(() => {
    const controls = animate(count, value, { duration: 0.6, ease: "easeOut" });
    return () => controls.stop();
  }, [count, value]);
  return <motion.span className="tabular-nums">{rounded}</motion.span>;
}

// Re-renders every second while `active`, for countdowns and "quiet for N s" checks.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ImportProgress({
  platform,
  job,
  connection,
  lastEventAt,
}: {
  platform: Platform;
  job: PublicJob | null;
  connection: StreamConnection;
  lastEventAt: number;
}) {
  const now = useNow(true);
  const done = job?.progress.done ?? 0;
  const total = job?.progress.total;
  const fraction = total ? Math.min(1, done / total) : 0;

  // queued + attempts > 0 means it failed once and is waiting to retry (the "retrying" event).
  const retryAt = job?.status === "queued" && job.attempts > 0 && job.runAfter ? Date.parse(job.runAfter) : null;
  const retryIn = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1_000)) : null;
  const quiet = job?.status === "running" && now - lastEventAt > QUIET_HINT_AFTER_MS;

  let status: string;
  if (connection === "reconnecting") status = "Connection dropped, reconnecting…";
  else if (retryIn !== null && job?.error) status = `${job.error.message} Retrying in ${retryIn}s (attempt ${job.attempts + 1} of ${job.maxAttempts}).`;
  else if (retryIn !== null) status = "The server restarted; picking the import back up…";
  else if (!job || job.status === "queued") status = "Waiting for the importer…";
  else status = job.progress.message ?? `Fetching games from ${PLATFORM_NAMES[platform]}…`;

  return (
    <section aria-label="Import progress" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-3xl text-ink">
          <TickingNumber value={done} />
        </span>
        <span className="text-sm text-graphite/70">{total ? `of ${total} games` : "games"}</span>
      </div>

      {/* A thin rule that grows from the left as games arrive. scaleX animates on the GPU. */}
      <div className="h-px w-full bg-ink/15">
        <motion.div
          className="h-px origin-left bg-ink"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: fraction }}
          transition={{ type: "spring", stiffness: 120, damping: 24 }}
        />
      </div>

      <p className="text-sm text-graphite" role="status" aria-live="polite">
        {status}
      </p>
      {quiet && (
        <p className="text-sm text-graphite/70">
          Still working. {PLATFORM_NAMES[platform]} may have asked us to wait (up to a minute) before the next request.
        </p>
      )}
    </section>
  );
}
