import { getDb, appClock, isDemoMode } from "@carerelay/domain";
import { getProvider, aiModeLabel } from "@carerelay/agents";

export function deps() {
  const db = getDb();
  return { db, clock: appClock(db), provider: getProvider() };
}
export const voiceEnabled = () => !!process.env.ELEVENLABS_API_KEY?.trim();
export const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
export { isDemoMode, aiModeLabel };
