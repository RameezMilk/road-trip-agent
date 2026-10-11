import type { Itinerary, ItineraryStop, RouteLeg } from "../schemas";
import { type PlacedStop, rescheduleFrom } from "./schedule";
import { formatDuration, formatTime, toZonedIso } from "./time";

/**
 * A road trip has to work for the people in the car. These checks run on the real schedule (OSRM drive
 * times + dwell), after Gemini picked the stops, so the planner can send a draft back with concrete
 * problems. Thresholds are slightly more lenient than what Gemini is asked for, so near-misses don't
 * trigger a repair round.
 *
 * Sources:
 * - Breaks: AAA advises a break every 2 hours or 100 miles; the National Safety Council, 15 minutes every
 *   2 hours. The CDC (Yellow Book) recommends frequent walking on journeys over 4 hours (blood clots).
 * - Daily driving: travel-safety guidance commonly caps a day at about 8 hours behind the wheel.
 * - Mealtimes: USDA/ATUS — US eating peaks noon–1 PM and 6–7 PM; breakfast mostly 7–10 AM.
 */

/** Local minutes since midnight, [from, to), when a sit-down meal can reasonably start. */
export const MEAL_WINDOWS: ReadonlyArray<{ name: string; from: number; to: number }> = [
  { name: "breakfast", from: 6 * 60 + 30, to: 10 * 60 + 30 },
  { name: "lunch", from: 11 * 60, to: 14 * 60 + 30 },
  { name: "dinner", from: 17 * 60, to: 21 * 60 },
];
/** A food stop this short is a coffee / ice-cream / snack stop: exempt from mealtime rules. */
export const SNACK_MAX_MINUTES = 20;
/** Two sit-down meals closer than this, the same day, are back to back. */
export const MIN_MEAL_GAP_MINUTES = 3 * 60;
/** Driving allowed before a stop of at least BREAK_MIN_MINUTES (asked: 2 h; checked with slack). */
export const MAX_DRIVE_WITHOUT_BREAK_MINUTES = 2.5 * 60;
export const BREAK_MIN_MINUTES = 10;
/** Driving per day (asked: ~8 h; checked with slack). */
export const MAX_DAILY_DRIVE_MINUTES = 9 * 60;
/** Arriving anywhere in [23:00, 05:00) local means driving at night. */
const NIGHT_FROM = 23 * 60;
const NIGHT_TO = 5 * 60;

/** "2026-10-17T12:30:00-04:00" (already in the trip's time zone) → 750. */
const localMinutes = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));

const isMeal = (s: ItineraryStop) => s.kind === "restaurant" && s.dwellMinutes > SNACK_MAX_MINUTES;

/** Code-added breaks split a long stretch evenly into pieces of at most 2 hours. */
const BREAK_EVERY_MINUTES = 120;
/** A leg (or stretch of legs) this long without a stop gets stretch breaks. */
const NEEDS_BREAK_MINUTES = 135;

/**
 * Where to add 15-minute stretch breaks on stretches longer than ~2¼ h without a real stop (the drive home
 * is the usual culprit): evenly spaced points on the real route geometry, so no piece is over 2 hours.
 * `afterIndex` is the stop the break follows; several breaks on one leg come in driving order.
 */
export function breakPoints(
  stops: PlacedStop[],
  legs: RouteLeg[],
): Array<{ afterIndex: number; order: number; day: number; latLng: { lat: number; lng: number } }> {
  const out: Array<{ afterIndex: number; order: number; day: number; latLng: { lat: number; lng: number } }> = [];
  let since = 0;
  for (let i = 1; i < stops.length; i++) {
    const stop = stops[i] as PlacedStop;
    const prev = stops[i - 1] as PlacedStop;
    const leg = legs[i - 1];
    if (prev.day !== stop.day || prev.kind === "lodging") since = 0;
    const minutes = (leg?.durationSeconds ?? 0) / 60;
    const total = since + minutes;
    if (leg && minutes > 0 && total > NEEDS_BREAK_MINUTES && leg.geometry.length >= 2) {
      const breaks = Math.ceil(total / BREAK_EVERY_MINUTES) - 1;
      let last = since;
      for (let j = 1; j <= breaks; j++) {
        const at = Math.max((j * total) / (breaks + 1), since + 0.1 * minutes); // overdue → early in this leg
        const f = (at - since) / minutes;
        const [lat, lng] = leg.geometry[Math.round(f * (leg.geometry.length - 1))] as [number, number];
        out.push({ afterIndex: i - 1, order: j - 1, day: stop.day, latLng: { lat, lng } });
        last = at;
      }
      since = total - last;
    } else {
      since = total;
    }
    if (stop.dwellMinutes >= BREAK_MIN_MINUTES || stop.kind === "lodging") since = 0;
  }
  return out;
}

/** A 15-minute stop to get out and walk, at a point on the highway (the town names it). */
export function stretchBreak(
  id: string,
  point: { day: number; latLng: { lat: number; lng: number } },
  town: string | null,
): PlacedStop {
  return {
    id,
    day: point.day,
    kind: "rest_stop",
    name: town ? `Stretch break near ${town}` : "Stretch break",
    address: town,
    latLng: point.latLng,
    geocodeSource: "approximate",
    dwellMinutes: 15,
    note: "15 minutes to get out, walk and stretch: a break every 2 hours of driving (AAA); sitting for hours raises blood-clot risk (CDC).",
    sustainable: false,
    sourceUrl: null,
    webEstimateCostPerPersonUsd: null,
  };
}

/** Where an early meal is moved to: a little into its window (7:30 AM, 11:45 AM, 5:45 PM). */
const MEAL_TARGETS = [7 * 60 + 30, 11 * 60 + 45, 17 * 60 + 45];
/** Waiting longer than this for a mealtime isn't a fix; the draft goes back to Gemini instead. */
const MAX_MEAL_WAIT_MINUTES = 3 * 60;
/** Stops where it's natural to linger until a meal (not gas stations or rest areas). */
const LINGER_KINDS = new Set(["origin", "destination", "attraction", "scenic", "lodging"]);
/** Leaving later than this to make breakfast/lunch line up isn't reasonable. */
const LATEST_DEPARTURE_MINUTES = 10 * 60 + 30;

/**
 * A meal that would start before its mealtime (dinner at 4:20 PM) is moved to the mealtime the way people
 * would do it: linger longer at the previous activity, or leave a bit later in the morning. Everything
 * after it shifts accordingly. Deterministic, so no extra Gemini round for the most common miss.
 */
export function alignMeals(stops: ItineraryStop[], legs: RouteLeg[], timeZone: string): ItineraryStop[] {
  let out = stops.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    const meal = out[i] as ItineraryStop;
    const prev = out[i - 1] as ItineraryStop;
    if (!isMeal(meal) || !meal.arriveAt || !prev.departAt) continue;
    const arrive = localMinutes(meal.arriveAt);
    if (MEAL_WINDOWS.some((w) => arrive >= w.from && arrive < w.to)) continue;
    const target = MEAL_TARGETS.find((t) => t > arrive && t - arrive <= MAX_MEAL_WAIT_MINUTES);
    if (target === undefined) continue;
    const wait = target - arrive;
    const overnight = prev.day < meal.day || prev.kind === "origin";
    if (!LINGER_KINDS.has(prev.kind) && !overnight) continue;
    if (overnight && localMinutes(prev.departAt) + wait > LATEST_DEPARTURE_MINUTES) continue;
    prev.departAt = toZonedIso(new Date(Date.parse(prev.departAt) + wait * 60_000), timeZone);
    if (!overnight) prev.dwellMinutes += wait;
    out = rescheduleFrom(out, legs, i, timeZone);
  }
  return out;
}

/** Human-schedule problems in an itinerary, as short sentences Gemini can act on. Empty = fine. */
export function scheduleIssues(itinerary: Itinerary): string[] {
  const { stops, legs, timeZone: tz } = itinerary;
  const at = (iso: string) => formatTime(iso, tz);
  const issues: string[] = [];

  // Meals at mealtimes, and not back to back.
  const mealsByDay = new Map<number, ItineraryStop[]>();
  for (const stop of stops) {
    if (!isMeal(stop) || !stop.arriveAt) continue;
    const minutes = localMinutes(stop.arriveAt);
    if (!MEAL_WINDOWS.some((w) => minutes >= w.from && minutes < w.to)) {
      issues.push(
        `Day ${stop.day}: ${stop.name} is a meal at ${at(stop.arriveAt)}, which isn't a mealtime (breakfast 7–10 AM, lunch 11:30 AM–1:30 PM, dinner 5:30–8 PM).`,
      );
    }
    mealsByDay.set(stop.day, [...(mealsByDay.get(stop.day) ?? []), stop]);
  }
  for (const [day, meals] of mealsByDay) {
    for (let i = 1; i < meals.length; i++) {
      const a = meals[i - 1] as ItineraryStop;
      const b = meals[i] as ItineraryStop;
      const gap = Date.parse(b.arriveAt as string) - Date.parse(a.arriveAt as string);
      if (gap < MIN_MEAL_GAP_MINUTES * 60_000) {
        issues.push(
          `Day ${day}: ${a.name} (${at(a.arriveAt as string)}) and ${b.name} (${at(b.arriveAt as string)}) are two meals back to back; space meals at least 3.5 hours apart.`,
        );
      }
    }
  }

  // Nobody skips lunch on the road, or dinner on a day that runs into the evening.
  const days = [...new Set(stops.map((s) => s.day))];
  for (const day of days) {
    const today = stops.filter((s) => s.day === day);
    const first = today.find((s) => s.departAt)?.departAt ?? today[0]?.arriveAt;
    const last = [...today].reverse().find((s) => s.arriveAt)?.arriveAt;
    if (!first || !last) continue;
    const [from, to] = [localMinutes(first), localMinutes(last)];
    const ate = (w: { from: number; to: number }) =>
      (mealsByDay.get(day) ?? []).some((m) => {
        const t = localMinutes(m.arriveAt as string);
        return t >= w.from && t < w.to;
      });
    const lunch = MEAL_WINDOWS[1] as (typeof MEAL_WINDOWS)[number];
    const dinner = MEAL_WINDOWS[2] as (typeof MEAL_WINDOWS)[number];
    if (from < 12 * 60 && to > 14 * 60 && !ate(lunch)) {
      // Where they'll be around 12:30, so the fix can pick a real place there.
      const near = today
        .filter((s) => s.arriveAt)
        .sort(
          (a, b) =>
            Math.abs(localMinutes(a.arriveAt as string) - 750) - Math.abs(localMinutes(b.arriveAt as string) - 750),
        )[0];
      const where = near
        ? ` — around then the group is at or near ${near.name.replace(/^Stretch break near /, "")}`
        : "";
      issues.push(`Day ${day}: no lunch stop (11:30 AM–1:30 PM)${where}.`);
    }
    if (from < 17 * 60 && to > 20 * 60 && !ate(dinner)) issues.push(`Day ${day}: no dinner stop (5:30–8 PM).`);
  }

  // Breaks: never more than ~2 h of driving without a real stop; at most ~8 h of driving a day.
  let sinceBreak = 0;
  let stretchStart = stops[0];
  const drivenByDay = new Map<number, number>();
  for (let i = 1; i < stops.length; i++) {
    const stop = stops[i] as ItineraryStop;
    const prev = stops[i - 1] as ItineraryStop;
    const minutes = (legs[i - 1]?.durationSeconds ?? 0) / 60;
    drivenByDay.set(stop.day, (drivenByDay.get(stop.day) ?? 0) + minutes);
    if (prev.day !== stop.day) {
      sinceBreak = 0; // an overnight stop is a break
      stretchStart = prev;
    }
    sinceBreak += minutes;
    if (sinceBreak > MAX_DRIVE_WITHOUT_BREAK_MINUTES) {
      issues.push(
        `Day ${stop.day}: ${formatDuration(sinceBreak * 60)} of driving from ${stretchStart?.name} to ${stop.name} without a break; stop at least every 2 hours to walk around (a rest stop, park or overlook).`,
      );
    }
    const isBreak = stop.dwellMinutes >= BREAK_MIN_MINUTES || stop.kind === "lodging" || i === stops.length - 1;
    if (isBreak || sinceBreak > MAX_DRIVE_WITHOUT_BREAK_MINUTES) {
      sinceBreak = 0;
      stretchStart = stop;
    }
    if (stop.arriveAt) {
      const minutesOfDay = localMinutes(stop.arriveAt);
      if (minutesOfDay >= NIGHT_FROM || minutesOfDay < NIGHT_TO) {
        issues.push(`Day ${stop.day}: arriving at ${stop.name} at ${at(stop.arriveAt)} means driving at night.`);
      }
    }
  }
  for (const [day, minutes] of drivenByDay) {
    if (minutes > MAX_DAILY_DRIVE_MINUTES) {
      issues.push(`Day ${day}: ${formatDuration(minutes * 60)} of driving; keep each day to about 8 hours.`);
    }
  }
  return issues;
}
