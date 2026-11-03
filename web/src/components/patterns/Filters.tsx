"use client";

import { COLORS, RANGES, SPEEDS, type DashboardFilters } from "@/lib/filters";

// Colour, speed and date range as rows of chips. One chip per group is on; "All" clears it.
// On a narrow screen the whole bar scrolls sideways inside itself, never the page.

const RANGE_LABEL = { "30d": "30 days", "90d": "90 days", "1y": "1 year" } as const;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function Filters({ value, onChange }: { value: DashboardFilters; onChange: (next: DashboardFilters) => void }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="group" aria-label="Filters">
      <div className="flex w-max items-center gap-x-5 gap-y-2 sm:w-auto sm:flex-wrap">
        <Group
          label="Colour"
          options={[{ key: undefined, label: "Both" }, ...COLORS.map((c) => ({ key: c, label: cap(c) }))]}
          current={value.color}
          onPick={(color) => onChange({ ...value, color })}
        />
        <Group
          label="Speed"
          options={[{ key: undefined, label: "All" }, ...SPEEDS.map((s) => ({ key: s, label: cap(s) }))]}
          current={value.speed}
          onPick={(speed) => onChange({ ...value, speed })}
        />
        <Group
          label="Played"
          options={[{ key: undefined, label: "All time" }, ...RANGES.map((r) => ({ key: r, label: RANGE_LABEL[r] }))]}
          current={value.range}
          onPick={(range) => onChange({ ...value, range })}
        />
      </div>
    </div>
  );
}

function Group<K extends string>({
  label,
  options,
  current,
  onPick,
}: {
  label: string;
  options: { key: K | undefined; label: string }[];
  current: K | undefined;
  onPick: (key: K | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={label}>
      <span className="mr-1 font-mono text-[11px] tracking-wide text-graphite/60 uppercase">{label}</span>
      {options.map((o) => {
        const on = o.key === current;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => !on && onPick(o.key)}
            className={`rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap transition-[background-color,color,border-color,transform] duration-150 active:scale-95 ${
              on ? "border-ink bg-ink text-bone" : "border-ink/20 text-graphite hover:border-ink hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
