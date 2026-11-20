"use client";

import { usePathname } from "next/navigation";

// The line at the bottom of every page: where the source code is, and whose work is inside.
// Blunderprint is under the GNU AGPL: a site running it has to offer its visitors the source,
// and this link is that offer. "Licences" opens THIRD_PARTY_NOTICES.md (Stockfish, the Lichess
// ports, the piece set, the fonts…).
const REPO = "https://github.com/Khizar-Islam/blunderprint";

// Ink text, underlined, a 44 px tall target, press feedback: the landing page's secondary link.
const LINK =
  "inline-flex min-h-11 items-center rounded px-1 text-ink underline decoration-ink/30 underline-offset-4 transition-colors hover:decoration-ink active:scale-[0.97]";

export function SiteFooter() {
  // The landing page's column is wider than the other pages'; the footer lines up with either.
  const wide = usePathname() === "/";
  return (
    <footer
      className={`mx-auto flex w-full flex-wrap items-center gap-x-3 pb-4 font-mono text-xs text-graphite ${
        wide ? "max-w-6xl px-4 sm:px-7" : "max-w-5xl px-3 sm:px-5"
      }`}
    >
      <span className="px-1">Free software (AGPL)</span>
      <a href={REPO} className={LINK}>
        Source
      </a>
      <a href={`${REPO}/blob/main/THIRD_PARTY_NOTICES.md`} className={LINK}>
        Licences
      </a>
    </footer>
  );
}
