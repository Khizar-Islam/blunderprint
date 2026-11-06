import Link from "next/link";
import { HealthStatus } from "@/components/HealthStatus";
import { demo } from "@/components/landing/demoData";
import { HeroPrint } from "@/components/landing/HeroPrint";
import { PlayerSearch } from "@/components/PlayerSearch";

// The landing page. The hero is drawn from a committed snapshot (src/data/demo.json), so it
// never waits on the API. The footer's health check doubles as the prewarm: it asks the API
// for /api/health as the page loads, so a sleeping Render instance starts waking while the
// hero plays, and the first click usually finds it awake.

const STEPS = [
  { title: "Import", text: "Up to 200 of your recent Chess.com or Lichess games, streamed in live." },
  { title: "Engine in your browser", text: "Stockfish runs on your own computer and marks every inaccuracy, mistake and blunder." },
  { title: "A coach that checks its claims", text: "An AI agent investigates the data with tools; code verifies every number and position it cites." },
];

// A secondary action: ink text, underlined, a 44 px tall target, press feedback.
const DEMO_LINK =
  "inline-flex min-h-11 items-center rounded px-1 font-medium text-ink underline decoration-ink/30 underline-offset-4 transition-colors hover:decoration-ink active:scale-[0.97]";

export default function Home() {
  const base = `/p/${demo.platform}/${encodeURIComponent(demo.username)}`;
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-14 px-5 pt-5 pb-10 sm:px-8 sm:pt-8">
      <header className="flex items-baseline justify-between gap-4">
        <span className="font-display text-xl text-ink">Blunderprint</span>
        <span className="font-mono text-xs text-graphite">an AI chess coach</span>
      </header>

      {/* Side by side only from 1280 px: narrower, the text column wraps the demo links below the fold. */}
      <section className="grid items-start gap-8 xl:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] xl:gap-12">
        <div className="flex flex-col gap-5 xl:pt-14">
          <h1 className="font-display text-[2.6rem] leading-[1.02] tracking-tight text-ink sm:text-6xl">
            Your mistakes <br />
            leave a print.
          </h1>
          <p className="max-w-md text-graphite sm:text-lg">
            Type a username. An engine in your browser finds the mistakes in your games; a coach finds the ones you keep making, and
            shows you where.
          </p>
          <PlayerSearch />
          {/* Most visitors (recruiters) have no chess account: the demo path is on the first screen. */}
          <p className="flex flex-wrap items-center gap-x-1 text-sm text-graphite sm:text-base xl:text-sm">
            {/* In the narrow 1280 px column: the label on its own line, both links on the next. */}
            <span className="mr-1 xl:basis-full">No account? Explore the demo:</span>
            <Link href={base} className={DEMO_LINK}>
              Open this Blunderprint
            </Link>
            <span aria-hidden="true" className="text-graphite/50">
              ·
            </span>
            <Link href={`${base}/coach`} className={DEMO_LINK}>
              Read the coach report
            </Link>
          </p>
        </div>
        <HeroPrint demo={demo} />
      </section>

      <section>
        <ol className="grid max-w-4xl gap-x-10 gap-y-4 border-t border-ink/15 pt-6 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[1.5rem_1fr] gap-x-2 gap-y-1">
              <span className="font-mono text-sm text-graphite tabular-nums">{i + 1}.</span>
              <span className="text-sm font-medium text-ink">{s.title}</span>
              <span className="col-start-2 text-sm text-graphite">{s.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mt-auto pt-4">
        <HealthStatus />
      </footer>
    </main>
  );
}
