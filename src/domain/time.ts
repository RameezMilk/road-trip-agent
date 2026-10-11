// Time-zone math without a library: trips are planned in local time but stored as ISO strings with offsets.

function partsIn(date: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** Minutes the zone is ahead of UTC at `date` (e.g. -240 for EDT). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  return Math.round((asUtc - (date.getTime() - date.getMilliseconds())) / 60_000);
}

/** Local wall-clock date + time in `timeZone` → instant. */
export function zonedToDate(localDate: string, localTime: string, timeZone: string): Date {
  const [y, m, d] = localDate.split("-").map(Number);
  const [hh, mm] = localTime.split(":").map(Number);
  const guess = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  const first = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first), timeZone) * 60_000);
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** Instant → `2026-10-17T09:00:00-04:00` in `timeZone`. */
export function toZonedIso(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  const off = offsetMinutes(date, timeZone);
  const sign = off < 0 ? "-" : "+";
  return `${p.year}-${pad(p.month ?? 0)}-${pad(p.day ?? 0)}T${pad(p.hour ?? 0)}:${pad(p.minute ?? 0)}:${pad(p.second ?? 0)}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** "Sat, Oct 17" */
export function formatLocalDate(localDate: string): string {
  return new Date(`${localDate}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "9:05 AM" in the trip's zone. */
export function formatTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
