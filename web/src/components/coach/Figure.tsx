import type { SlotKind } from "@/lib/api";

// A number in a coach answer ("7.9 errors per 100 moves", "88.2% of your blunders"). Every one
// was written by code from the player's data (backend agent/slots.ts), never by the model, and
// it looks like it: Geist Mono with tabular figures, set in the serif sentence like a figure in a
// chess book, on a teal rule. The rule draws in from the left once its sentence is shown
// (`animate`); it's a background, so the figure's box never moves (no layout shift), and with
// reduced motion or no animation frames the rule is simply there (globals.css figure-in).
// Screen readers read the plain text.

export function Figure({ text, kind, animate, delayMs = 0 }: { text: string; kind: SlotKind; animate: boolean; delayMs?: number }) {
  return (
    <span
      data-figure={kind}
      className={`figure-rule font-mono text-[0.86em] font-medium tracking-tight whitespace-normal text-ink tabular-nums ${animate ? "figure-in" : ""}`}
      style={animate ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      {text}
    </span>
  );
}
