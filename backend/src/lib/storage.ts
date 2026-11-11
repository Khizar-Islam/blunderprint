import mongoose from "mongoose";
import { logger } from "./logger.js";

// The storage gate (CLAUDE.md §7 "Storage budget"): new players stop being imported once the
// database reaches STORAGE_NEW_PLAYER_LIMIT_MB. Players already stored can still refresh (a
// re-import replaces games, it doesn't add a player), and demo players are never affected.
//
// What we measure: dataSize + indexSize from dbStats. That is what Atlas M0's 512 MB quota
// counts (the data uncompressed, plus the indexes), NOT storageSize (the compressed size on
// disk, which is smaller and would let us overshoot).
//
// dbStats is read at most once per cacheMs (5 minutes): imports and /api/health share the
// answer, and a cached promise means simultaneous requests share one read. One import adds
// ~1 MB (200 games × ~5.4 KB, measured 7 Nov 2026), and the new-player cap (40 a day) bounds
// how far five stale minutes can overshoot.

const MB = 1024 * 1024;

export interface DbSizes {
  dataSize: number;
  indexSize: number;
}

export interface StorageGateOptions {
  limitMb: number;
  cacheMs?: number;
  // Tests pass a fake; by default dbStats of the connected database.
  readStats?: () => Promise<DbSizes>;
  now?: () => number;
}

export interface StorageGate {
  limitMb: number;
  // dataSize + indexSize in MB (1 decimal), or null when it couldn't be read.
  usedMb(): Promise<number | null>;
  // true only when a reading says the limit is reached. An unreadable size doesn't block
  // imports: the import itself would fail anyway if the database were really down, and Atlas's
  // own quota is the hard backstop.
  full(): Promise<boolean>;
}

const readDbStats = async (): Promise<DbSizes> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Not connected");
  const stats = await db.stats();
  return { dataSize: Number(stats.dataSize ?? 0), indexSize: Number(stats.indexSize ?? 0) };
};

export function createStorageGate({ limitMb, cacheMs = 5 * 60_000, readStats = readDbStats, now = Date.now }: StorageGateOptions): StorageGate {
  let cached: { at: number; used: Promise<number | null> } | null = null;

  function usedMb(): Promise<number | null> {
    if (!cached || now() - cached.at >= cacheMs) {
      const at = now();
      const used = readStats()
        .then(({ dataSize, indexSize }) => Math.round(((dataSize + indexSize) / MB) * 10) / 10)
        .catch((err: unknown) => {
          logger.warn("dbStats failed", { error: err instanceof Error ? err.message : String(err) });
          // Don't keep a failure for 5 minutes: the next request tries again.
          if (cached?.at === at) cached = null;
          return null;
        });
      cached = { at, used };
    }
    return cached.used;
  }

  return {
    limitMb,
    usedMb,
    async full() {
      const used = await usedMb();
      return used !== null && used >= limitMb;
    },
  };
}
