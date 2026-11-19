import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/Notice";
import { demo } from "@/components/landing/demoData";

// Shown for any address the app doesn't have, and wherever a page calls notFound() (an unknown
// platform, a username that can't exist, /dev/engine in production). Next sends it with HTTP
// status 404.
export const metadata: Metadata = { title: "Page not found · Blunderprint" };

export default function NotFound() {
  const demoPath = `/p/${demo.platform}/${encodeURIComponent(demo.username)}`;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-16">
      <header className="flex flex-col gap-3">
        <Link href="/" className="self-start rounded text-sm text-graphite/70 transition-colors hover:text-ink active:opacity-70">
          ← Blunderprint
        </Link>
        <h1 className="font-display text-4xl tracking-tight text-ink sm:text-5xl">Nothing on this square.</h1>
      </header>
      <Notice title="This page doesn't exist" link={{ href: "/", label: "Search for a player" }}>
        The address may be mistyped, or the page may have moved. A player&apos;s page looks like /p/lichess/a-username or
        /p/chesscom/a-username.
      </Notice>
      <p className="text-sm text-graphite">
        No account?{" "}
        <Link
          href={demoPath}
          className="inline-flex min-h-11 items-center rounded px-1 font-medium text-ink underline decoration-ink/30 underline-offset-4 transition-colors hover:decoration-ink active:scale-[0.97]"
        >
          Open the demo Blunderprint
        </Link>
      </p>
    </main>
  );
}
