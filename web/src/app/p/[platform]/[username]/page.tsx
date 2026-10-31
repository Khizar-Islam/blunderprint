import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlayerDashboard } from "@/components/PlayerDashboard";
import { isPlatform, PLATFORM_NAMES } from "@/lib/api";

type Props = PageProps<"/p/[platform]/[username]">;

// The docs don't say whether dynamic params arrive URL-decoded. Valid usernames have nothing
// to decode, so decoding is a no-op for them; for anything else, keep the raw text.
function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Next 16: params is a Promise, so both functions await it.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `${decodeParam(username)} · Blunderprint` };
}

export default async function PlayerPage({ params }: Props) {
  const { platform, username: raw } = await params;
  if (!isPlatform(platform)) notFound();
  const username = decodeParam(raw);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-16">
      <header className="flex flex-col gap-3">
        <Link
          href="/"
          className="self-start rounded text-sm text-graphite/70 transition-colors hover:text-ink active:opacity-70"
        >
          ← Blunderprint
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-4xl tracking-tight break-all text-ink sm:text-5xl">{username}</h1>
          <span className="font-mono text-sm text-graphite/70">{PLATFORM_NAMES[platform]}</span>
        </div>
      </header>
      {/* Keyed by player: a new player gets a fresh dashboard (state, requests, stream). */}
      <PlayerDashboard key={`${platform}:${username.toLowerCase()}`} platform={platform} username={username} />
    </main>
  );
}
