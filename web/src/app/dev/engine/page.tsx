import { notFound } from "next/navigation";
import { EngineLab } from "./EngineLab";

// A developer-only page for trying the browser engine on one pasted PGN and measuring how long
// a game takes at different node budgets (Stage 2). It talks to no API. In a production build
// it's a 404, so visitors never see it.
export default function EngineLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl tracking-tight">Engine lab</h1>
      <EngineLab />
    </main>
  );
}
