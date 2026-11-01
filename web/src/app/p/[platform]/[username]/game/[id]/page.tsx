import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GameReview } from "@/components/review/GameReview";
import { isPlatform } from "@/lib/api";

type Props = PageProps<"/p/[platform]/[username]/game/[id]">;

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `Game review · ${decodeParam(username)} · Blunderprint` };
}

// The game is fetched in the browser (GameReview), like the dashboard, so the cold-start
// "Waking the server up…" counter works here too. The page only checks the platform; whether
// the game belongs to this player is checked against the API's answer.
export default async function GamePage({ params }: Props) {
  const { platform, username: raw, id } = await params;
  if (!isPlatform(platform)) notFound();
  const username = decodeParam(raw);
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <GameReview key={id} platform={platform} username={username} gameId={id} />
    </main>
  );
}
