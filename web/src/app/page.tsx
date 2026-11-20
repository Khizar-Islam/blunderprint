import Link from "next/link";
import { HealthStatus } from "@/components/HealthStatus";
import { demo } from "@/components/landing/demoData";
import { Dive } from "@/components/landing/Dive";
import { PrintLink } from "@/components/landing/PrintLink";
import { PlayerSearch } from "@/components/PlayerSearch";
import { dayDate } from "@/lib/format";

// The landing page: the words, then one dive from the demo player's print down to a single move
// and the coach's sentence about it (components/landing/Dive.tsx). Everything it shows is a
// committed snapshot (src/data/demo.json), so the page never waits on the API. The words are
// rendered here, on the server: the headline is the first screen's largest element (LCP) and
// must not depend on the dive's script.
// The footer's health check doubles as the prewarm: it asks the API for /api/health as the page
// loads, so a sleeping Render instance starts waking while the visitor reads, and the first
// click usually finds it awake.

const REPO = "https://github.com/Khizar-Islam/blunderprint";

// A secondary action: ink text, underlined, a 44 px tall target, press feedback.
const DEMO_LINK =
  "inline-flex min-h-11 items-center rounded px-1 font-medium text-ink underline decoration-ink/30 underline-offset-4 transition-colors hover:decoration-ink active:scale-[0.97]";

// How it is built, in one line for a technical reader: each part links to its README section.
const BUILT = [
  { text: "engine in your browser", href: `${REPO}#2-the-engine-runs-in-your-browser` },
  { text: "an agent with tools", href: `${REPO}#4-the-coach-agent` },
  { text: "code checks every claim", href: `${REPO}#verify` },
];

export default function Home() {
  const base = `/p/${demo.platform}/${encodeURIComponent(demo.username)}`;
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 sm:px-8">
      <Dive>
        <div className="flex flex-col gap-5 pt-5 pb-8 sm:pt-8">
          <header className="flex items-baseline justify-between gap-4 xl:mb-14">
            <span className="font-display text-xl text-ink">Blunderprint</span>
            <span className="font-mono text-xs text-graphite">an AI chess coach</span>
          </header>
          <h1 className="font-display text-4xl leading-[1.05] tracking-tight text-ink sm:text-6xl">
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
            {/* A click carries the print below onto the dashboard's (components/landing/PrintLink.tsx). */}
            <PrintLink platform={demo.platform} username={demo.username} className={DEMO_LINK}>
              Open this Blunderprint
            </PrintLink>
            <span aria-hidden="true" className="text-graphite/70">
              ·
            </span>
            <Link href={`${base}/coach`} className={DEMO_LINK}>
              Read the coach report
            </Link>
          </p>
        </div>
      </Dive>

      <footer className="mt-auto flex flex-col gap-2 pt-10 pb-2">
        <p className="flex flex-wrap items-center gap-x-1 font-mono text-sm text-graphite" aria-label="How it is built">
          {BUILT.map((b, i) => (
            <span key={b.href} className="inline-flex items-center gap-x-1">
              {i > 0 && (
                <span aria-hidden="true" className="text-graphite/70">
                  ·
                </span>
              )}
              <a href={b.href} className={DEMO_LINK.replace("font-medium ", "")}>
                {b.text}
              </a>
            </span>
          ))}
        </p>
        <p className="px-1 font-mono text-xs text-graphite">
          The demo: {demo.platform === "lichess" ? "Lichess" : "Chess.com"} · {demo.username} · {demo.analysedGames} public games, analysed in
          the browser · as of {dayDate(demo.lastImportedAt)}. Not affiliated with the player: these are the account&apos;s public games.
        </p>
        <HealthStatus />
      </footer>
    </main>
  );
}
