import Link from "next/link";
import { PlayerSearch } from "@/components/PlayerSearch";
import { Arrow } from "./Arrow";
import { demo } from "./demoData";
import { PrintLink } from "./PrintLink";

// The landing's words (a Server Component: the headline is the first screen's largest element
// and must be in the HTML the server sends).
//
// - The masthead is one ruled line across the whole page, on the page's two columns: the name
//   over the words, what it is over the print's left edge (38%, diveTimeline.ts stageBox), the
//   source at the right edge.
// - From 1280 px the headline's capitals start level with the print's top edge (--print-top,
//   globals.css: the dive's canvas reads the same value).
// - Two ways in, the demo first: most visitors have no chess account, so "See a real one" is
//   the page's main action; a visitor's own games are one ruled line under it.

const REPO = "https://github.com/Khizar-Islam/blunderprint";
const GAMES = demo.analysedGames;

export function HeroWords() {
  const base = `/p/${demo.platform}/${encodeURIComponent(demo.username)}`;
  return (
    <div className="flex flex-col pb-10">
      {/* 294.12% = the whole page from a column that is 34% of it. */}
      <header className="flex h-11 items-end justify-between gap-4 border-b border-ink pb-2 xl:grid xl:w-[294.12%] xl:grid-cols-[38%_1fr_auto] xl:gap-0">
        <span className="font-display text-xl leading-none text-ink">Blunderprint</span>
        <span className="font-mono text-xs text-graphite">
          An AI chess coach<span className="hidden sm:inline"> for your own games</span>
        </span>
        <a
          href={REPO}
          className="-my-3 hidden min-h-11 items-end rounded pb-3 font-mono text-xs text-graphite underline decoration-transparent underline-offset-4 transition-colors hover:text-ink hover:decoration-ink active:scale-[0.97] xl:inline-flex"
        >
          Source
        </a>
      </header>

      <h1 className="mt-7 font-display text-4xl leading-[1.05] tracking-tight text-ink sm:text-6xl xl:mt-[calc(var(--print-top)-44px-5px)]">
        Your mistakes <br />
        leave a print.
      </h1>
      <p className="mt-4 max-w-md font-display text-xl leading-[1.4] text-pretty text-graphite xl:mt-5 xl:max-w-none">
        An engine in your browser finds your mistakes. A coach finds the ones you keep making, and shows you where.
      </p>

      <div className="mt-6 flex max-w-md flex-col border-t border-ink xl:max-w-none">
        {/* A click carries the print beside it onto the dashboard's (PrintLink.tsx). */}
        <PrintLink
          platform={demo.platform}
          username={demo.username}
          className="group grid grid-cols-[1fr_auto] items-center gap-x-4 rounded-sm border-b border-ink/25 py-3 transition-colors hover:border-ink active:scale-[0.99]"
        >
          <span className="font-display text-2xl leading-tight text-ink">No account? See a real one</span>
          <Arrow className="row-span-2 text-ink" />
          <span className="font-mono text-xs text-graphite">
            {demo.username}&apos;s print · {GAMES} public games
          </span>
        </PrintLink>
        <Link
          href={`${base}/coach`}
          className="group flex min-h-11 items-center justify-between gap-x-4 rounded-sm border-b border-ink/25 text-base text-ink transition-colors hover:border-ink active:scale-[0.99]"
        >
          Read what the coach found in it
          <Arrow className="text-graphite" />
        </Link>
        <PlayerSearch />
      </div>
    </div>
  );
}
