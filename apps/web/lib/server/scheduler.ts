import { runSweepAll } from "@carerelay/domain";
import { deps } from "./deps";

const g = globalThis as unknown as { __crScheduler?: NodeJS.Timeout; __crSweeping?: boolean };

export function startScheduler() {
  if (g.__crScheduler) return;
  const tick = async () => {
    if (g.__crSweeping) return;
    g.__crSweeping = true;
    try {
      const { db, clock } = deps();
      await runSweepAll(db, clock);
    } catch (e) {
      console.error("[care-sweep] failed:", (e as Error).message);
    } finally {
      g.__crSweeping = false;
    }
  };
  g.__crScheduler = setInterval(tick, 60_000);
  setTimeout(tick, 5_000);
  console.log("[care-sweep] scheduler started (every 60 s)");
}
