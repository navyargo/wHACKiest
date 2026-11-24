/** Timezone helpers built on Intl (no tz library). */
export const DEFAULT_TZ = "Asia/Kolkata";

function parts(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(date)) p[x.type] = x.value;
  return p;
}

/** Minutes the zone is ahead of UTC at `date` (IST → 330). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = parts(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** "2025-01-10", "08:00", "Asia/Kolkata" → the UTC instant. */
export function zonedTimeToUtc(dateStr: string, time: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = tzOffsetMinutes(new Date(guess), tz);
  return new Date(guess - off * 60000);
}

export function localDateString(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTimeString(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}`;
}

export function addDaysToDateString(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function startOfLocalDay(date: Date, tz: string): Date {
  return zonedTimeToUtc(localDateString(date, tz), "00:00", tz);
}

export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;
