import type { GuardLimits, Guards } from "../src/lib/guards.js";
import type { StorageGate } from "../src/lib/storage.js";
import { createVisitorKey } from "../src/lib/visitor.js";

// Guards for route tests: generous limits unless a test lowers one, a fixed salt, and a storage
// gate whose size the test sets (no dbStats).
export const TEST_SALT = "test-salt-test-salt-test-salt-32";

export function fakeStorage(usedMb: number | null = 10, limitMb = 120): StorageGate & { set(mb: number | null): void } {
  let used = usedMb;
  return {
    limitMb,
    usedMb: async () => used,
    full: async () => used !== null && used >= limitMb,
    set(mb) {
      used = mb;
    },
  };
}

export function testGuards(limits: Partial<GuardLimits> = {}, storage: StorageGate = fakeStorage(), now?: () => Date): Guards {
  return {
    visitorKey: createVisitorKey(TEST_SALT),
    limits: {
      importsPerHour: 100,
      importsPerDay: 100,
      reportsPerDay: 100,
      requestsPerMinute: 10_000,
      newPlayersPerDay: 100,
      importQueueMax: 100,
      ...limits,
    },
    storage,
    ...(now ? { now } : {}),
  };
}
