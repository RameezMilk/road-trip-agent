import type { Itinerary } from "../schemas";
import { METERS_PER_MILE } from "./geo";

export interface ItineraryDiff {
  added: string[];
  removed: string[];
  retimed: number;
  driveMinutesDelta: number;
  milesDelta: number;
  costPerPersonDeltaUsd: number;
}

const key = (s: { kind: string; name: string }) => `${s.kind}:${s.name.trim().toLowerCase()}`;

/** Deterministic change summary between two versions (stops matched by kind + name). */
export function diffItineraries(prev: Itinerary, next: Itinerary): ItineraryDiff {
  const prevKeys = new Map(prev.stops.map((s) => [key(s), s]));
  const nextKeys = new Map(next.stops.map((s) => [key(s), s]));
  const added = next.stops.filter((s) => !prevKeys.has(key(s))).map((s) => s.name);
  const removed = prev.stops.filter((s) => !nextKeys.has(key(s))).map((s) => s.name);
  let retimed = 0;
  for (const s of next.stops) {
    const before = prevKeys.get(key(s));
    if (before && (before.arriveAt !== s.arriveAt || before.departAt !== s.departAt)) retimed++;
  }
  return {
    added,
    removed,
    retimed,
    driveMinutesDelta: Math.round((next.totals.driveSeconds - prev.totals.driveSeconds) / 60),
    milesDelta: Math.round(((next.totals.distanceMeters - prev.totals.distanceMeters) / METERS_PER_MILE) * 10) / 10,
    costPerPersonDeltaUsd:
      Math.round((next.totals.estimatedCostPerPersonUsd - prev.totals.estimatedCostPerPersonUsd) * 100) / 100,
  };
}

const signed = (n: number, unit: string) => `${n > 0 ? "+" : ""}${n}${unit}`;

export function formatDiff(diff: ItineraryDiff): string {
  const lines: string[] = [];
  if (diff.added.length) lines.push(`• ➕ Added: ${diff.added.join(", ")}`);
  if (diff.removed.length) lines.push(`• ➖ Removed: ${diff.removed.join(", ")}`);
  if (diff.retimed) lines.push(`• 🕒 ${diff.retimed} stop${diff.retimed === 1 ? "" : "s"} retimed`);
  const deltas: string[] = [];
  if (diff.driveMinutesDelta) deltas.push(`driving ${signed(diff.driveMinutesDelta, " min")}`);
  if (diff.milesDelta) deltas.push(`distance ${signed(diff.milesDelta, " mi")}`);
  if (diff.costPerPersonDeltaUsd) deltas.push(`cost ${signed(diff.costPerPersonDeltaUsd, " $/person")}`);
  if (deltas.length) lines.push(`• 📊 ${deltas.join(", ")}`);
  return lines.length ? lines.join("\n") : "No changes to stops or timing.";
}
