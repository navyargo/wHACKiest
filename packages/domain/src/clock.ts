import type { Db } from "./db";

/** All time-based logic takes a Clock. Real in production, virtual in Demo Mode, fixed in tests. */
export interface Clock {
  now(): Promise<Date>;
}

export const realClock: Clock = { now: async () => new Date() };

export function fixedClock(at: Date | string): Clock & { set(d: Date | string): void; advance(ms: number): void } {
  let t = new Date(at);
  return {
    now: async () => new Date(t),
    set: (d) => (t = new Date(d)),
    advance: (ms) => (t = new Date(t.getTime() + ms)),
  };
}

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

/** Virtual clock: real time + DemoClock.offsetMinutes. */
export function demoClock(db: Db): Clock {
  return {
    async now() {
      const row = await db.demoClock.findUnique({ where: { id: 1 } });
      return new Date(Date.now() + (row?.offsetMinutes ?? 0) * 60_000);
    },
  };
}

export function appClock(db: Db): Clock {
  return isDemoMode() ? demoClock(db) : realClock;
}
