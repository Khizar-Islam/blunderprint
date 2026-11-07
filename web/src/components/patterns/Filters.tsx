"use client";

import { COLORS, RANGES, SPEEDS, type DashboardFilters } from "@/lib/filters";
import { useIndicator } from "@/lib/useIndicator";

// Colour, speed and date range as rows of chips. One chip per group is on; "All" clears it.
// On a narrow screen the whole bar scrolls sideways inside itself, never the page.
// In each group, one ink pill slides to the chosen chip (lib/useIndicator.ts).

const RANGE_LABEL = { "30d": "30 days", "90d": "90 days", "1y": "1 year" } as const;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function Filters({ value, onChange }: { value: DashboardFilters; onChange: (next: DashboardFilters) => void }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="group" aria-label="Filters">
      <div className="flex w-max items-center gap-x-5 gap-y-2 sm:w-auto sm:flex-wrap">
        <ChipGroup
          label="Colour"
          options={[{ key: undefined, label: "Both" }, ...COLORS.map((c) => ({ key: c, label: cap(c) }))]}
          current={value.color}
          onPick={(color) => onChange({ ...value, color })}
        />
        <ChipGroup
          label="Speed"
          options={[{ key: undefined, label: "All" }, ...SPEEDS.map((s) => ({ key: s, label: cap(s) }))]}
          current={value.speed}
          onPick={(speed) => onChange({ ...value, speed })}
        />
        <ChipGroup
          label="Played"
          options={[{ key: undefined, label: "All time" }, ...RANGES.map((r) => ({ key: r, label: RANGE_LABEL[r] }))]}
          current={value.range}
          onPick={(range) => onChange({ ...value, range })}
        />
      </div>
    </div>
  );
}

// A row of chips, one of them on. Also the dashboard's "per 100 moves / per game" switch.
// `showLabel` false: the label is only read out (aria-label), not shown.
export function ChipGroup<K extends string>({
  label,
  options,
  current,
  onPick,
  showLabel = true,
}: {
  label: string;
  options: { key: K | undefined; label: string }[];
  current: K | undefined;
  onPick: (key: K | undefined) => void;
  showLabel?: boolean;
}) {
  const chosen = options.findIndex((o) => o.key === current);
  const { container, pill } = useIndicator<HTMLDivElement, HTMLSpanElement>(chosen < 0 ? null : chosen);
  return (
    <div ref={container} className="group relative flex items-center gap-1.5" role="radiogroup" aria-label={label}>
      {showLabel && <span className="mr-1 font-mono text-[11px] tracking-wide text-graphite/60 uppercase">{label}</span>}
      <span ref={pill} className="seg-indicator rounded-full bg-ink opacity-0" aria-hidden="true" />
      {options.map((o) => {
        const on = o.key === current;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            data-segment
            aria-checked={on}
            onClick={() => !on && onPick(o.key)}
            className={`relative rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap transition-[background-color,color,border-color,transform] duration-150 active:scale-95 ${
              on
                ? "border-ink bg-ink text-bone hover:text-square-light group-data-[indicator=on]:bg-transparent"
                : "border-ink/20 text-graphite hover:border-ink hover:bg-square-light/50 hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
