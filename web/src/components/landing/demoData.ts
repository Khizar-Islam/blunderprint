import type { CoachEvidence, CoachStat, Platform, Summary } from "@/lib/api";
import raw from "@/data/demo.json";

// The landing page's demo: a committed snapshot of a frozen demo player (scripts/snapshot-demo.mjs),
// so the hero never waits on the API. heroTimeline.test.ts checks the file against these types.

export type DemoRibbon = Summary["ribbons"][number];

export interface DemoNote {
  title: string; // the pattern's label, written by code
  stat: CoachStat;
  evidence: Omit<CoachEvidence, "ribbon">;
}

export interface DemoSnapshot {
  platform: Platform;
  username: string;
  takenAt: string;
  lastImportedAt: string;
  reportGeneratedAt: string;
  analysedGames: number;
  notes: DemoNote[];
  ribbons: DemoRibbon[];
}

// JSON imports type string fields as plain `string`; the test checks the narrower values.
export const demo = raw as unknown as DemoSnapshot;
