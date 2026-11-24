/** Starts the in-process care-sweep scheduler (every minute) on the Node.js server runtime. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SCHEDULER_ENABLED !== "true") return;
  const { startScheduler } = await import("./lib/server/scheduler");
  startScheduler();
}
