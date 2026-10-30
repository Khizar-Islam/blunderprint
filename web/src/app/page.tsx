import { HealthStatus } from "@/components/HealthStatus";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-24">
      <h1 className="font-display text-6xl tracking-tight text-ink">Blunderprint</h1>
      <p className="max-w-md text-lg text-graphite">
        The recurring mistakes in your chess games, found with an engine and explained with evidence.
      </p>
      <HealthStatus />
    </main>
  );
}
