import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CoachPage } from "@/components/coach/CoachPage";
import { isPlatform, isValidUsername, PLATFORM_NAMES } from "@/lib/api";

type Props = PageProps<"/p/[platform]/[username]/coach">;

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `Coach report · ${decodeParam(username)} · Blunderprint` };
}

// The coach page reads everything in the browser (CoachPage), so the "Waking the server up…"
// counter works here too. It never starts a run by itself: only a click does (the dashboard's
// "Coach me", or Refresh / Try again here), so a reload or a shared link can't spend AI calls.
export default async function CoachRoute({ params }: Props) {
  const { platform, username: raw } = await params;
  if (!isPlatform(platform)) notFound();
  const username = decodeParam(raw);
  if (!isValidUsername(platform, username)) notFound();
  const dashboard = `/p/${platform}/${encodeURIComponent(username)}`;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-16">
      <header className="flex flex-col gap-3">
        <Link href={dashboard} className="self-start rounded text-sm text-graphite/70 transition-colors hover:text-ink active:opacity-70">
          ← {username}&apos;s dashboard
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-4xl tracking-tight text-ink sm:text-5xl">Coach report</h1>
          <span className="font-mono text-sm break-all text-graphite/70">
            {username} · {PLATFORM_NAMES[platform]}
          </span>
        </div>
      </header>
      <CoachPage key={`${platform}:${username.toLowerCase()}`} platform={platform} username={username} />
    </main>
  );
}
