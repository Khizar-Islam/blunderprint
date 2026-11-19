"use client"; // an error boundary must be a Client Component

import Link from "next/link";
import { useEffect } from "react";
import { Notice } from "@/components/Notice";

// Shown in place of a page that threw while rendering (a bug of ours, not a failed request:
// those have their own messages on each page). The visitor gets a fixed message, never the
// error's own text. `retry` (Next 16) re-fetches and re-renders the page that failed.
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    // The browser console is the only place this goes: the site has no error collector. A
    // server error arrives with only a digest (an id that matches the server's log line).
    const digest = typeof error === "object" && error !== null && "digest" in error ? error.digest : undefined;
    console.error("page_error", digest ?? error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-16">
      <header className="flex flex-col gap-3">
        <Link href="/" className="self-start rounded text-sm text-graphite/70 transition-colors hover:text-ink active:opacity-70">
          ← Blunderprint
        </Link>
        <h1 className="font-display text-4xl tracking-tight text-ink sm:text-5xl">That was a blunder. Ours.</h1>
      </header>
      <Notice title="This page hit an error" action={{ label: "Try again", onClick: () => retry() }} link={{ href: "/", label: "Back to the start" }}>
        Something went wrong while showing this page. Your games and reports are not affected. Try again, or start over from the
        search.
      </Notice>
    </main>
  );
}
