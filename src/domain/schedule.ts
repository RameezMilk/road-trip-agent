import type { Itinerary, ItineraryStop, ResolvedRequirements, RouteLeg } from "../schemas";
import { computeSustainability } from "./sustainability";
import { addDays, toZonedIso, zonedToDate } from "./time";

/** A located stop before times are assigned. */
export type PlacedStop = Omit<ItineraryStop, "arriveAt" | "departAt">;

const MINUTE = 60_000;

/**
 * Deterministic schedule: day N starts at its departure time on startDate + N − 1; each arrival is the
 * previous departure plus the routed leg duration; departure is arrival plus dwell. A stop followed by a
 * later day (lodging) departs the next morning at that day's start time.
 */
export function scheduleStops(input: {
  stops: PlacedStop[];
  legs: RouteLeg[];
  startDate: string;
  dayDepartTimes: Map<number, string>;
  timeZone: string;
}): ItineraryStop[] {
  const { stops, legs, startDate, dayDepartTimes, timeZone } = input;
  const dayStart = (day: number) =>
    zonedToDate(addDays(startDate, day - 1), dayDepartTimes.get(day) ?? "09:00", timeZone);
  const out: ItineraryStop[] = [];
  let previousDepart: Date | null = null;

  stops.forEach((stop, i) => {
    const next = stops[i + 1];
    let arrive: Date | null = null;
    if (i > 0 && previousDepart) {
      const leg = legs[i - 1];
      arrive = new Date(previousDepart.getTime() + (leg?.durationSeconds ?? 0) * 1000);
    }
    let depart: Date | null = null;
    let dwellMinutes = stop.dwellMinutes;
    if (next) {
      if (!arrive) {
        depart = dayStart(stop.day);
        dwellMinutes = 0;
      } else if (next.day > stop.day) {
        const morning = dayStart(next.day);
        depart = new Date(Math.max(morning.getTime(), arrive.getTime() + stop.dwellMinutes * MINUTE));
        dwellMinutes = Math.min(24 * 60, Math.round((depart.getTime() - arrive.getTime()) / MINUTE));
      } else {
        depart = new Date(arrive.getTime() + stop.dwellMinutes * MINUTE);
      }
    } else {
      dwellMinutes = 0;
    }
    out.push({
      ...stop,
      dwellMinutes,
      arriveAt: arrive ? toZonedIso(arrive, timeZone) : null,
      departAt: depart ? toZonedIso(depart, timeZone) : null,
    });
    previousDepart = depart;
  });
  return out;
}

export function buildItinerary(input: {
  tripId: string;
  version: number;
  title: string;
  timeZone: string;
  resolved: ResolvedRequirements;
  stops: PlacedStop[];
  legs: RouteLeg[];
  dayDepartTimes: Map<number, string>;
  memberCount: number;
  vehicleMpg: number;
  gasPriceUsdPerGallon: number;
  rationale: string | null;
  droppedStops: string[];
  now?: Date;
}): Itinerary {
  const stops = scheduleStops({
    stops: input.stops,
    legs: input.legs,
    startDate: input.resolved.startDate,
    dayDepartTimes: input.dayDepartTimes,
    timeZone: input.timeZone,
  });
  return finalizeItinerary({ ...input, stops });
}

/** Recomputes totals + sustainability for already-timed stops (used after schedule shifts too). */
export function finalizeItinerary(input: {
  tripId: string;
  version: number;
  title: string;
  timeZone: string;
  resolved: ResolvedRequirements;
  stops: ItineraryStop[];
  legs: RouteLeg[];
  memberCount: number;
  vehicleMpg: number;
  gasPriceUsdPerGallon: number;
  rationale: string | null;
  droppedStops: string[];
  now?: Date;
}): Itinerary {
  const distanceMeters = input.legs.reduce((sum, l) => sum + l.distanceMeters, 0);
  const driveSeconds = input.legs.reduce((sum, l) => sum + l.durationSeconds, 0);
  const sustainability = computeSustainability({
    distanceMeters,
    memberCount: input.memberCount,
    vehicleMpg: input.vehicleMpg,
    gasPriceUsdPerGallon: input.gasPriceUsdPerGallon,
    stops: input.stops,
  });
  const fuelPerPerson = Math.round((sustainability.fuelCostUsd / sustainability.memberCount) * 100) / 100;
  const webEstimate = Math.round(input.stops.reduce((s, x) => s + (x.webEstimateCostPerPersonUsd ?? 0), 0) * 100) / 100;
  const estimated = Math.round((fuelPerPerson + webEstimate) * 100) / 100;
  const sources = new Set(input.legs.map((l) => l.source));
  return {
    tripId: input.tripId,
    version: input.version,
    title: input.title,
    timeZone: input.timeZone,
    startLocation: input.resolved.startLocation,
    endLocation: input.resolved.endLocation,
    tripType: input.resolved.tripType,
    stops: input.stops,
    legs: input.legs,
    totals: {
      distanceMeters,
      driveSeconds,
      fuelCostPerPersonUsd: fuelPerPerson,
      webEstimateStopCostPerPersonUsd: webEstimate,
      estimatedCostPerPersonUsd: estimated,
      budgetPerPersonUsd: input.resolved.budgetPerPersonUsd,
      overBudget: estimated > input.resolved.budgetPerPersonUsd,
    },
    sustainability,
    routeSource: sources.size > 1 ? "mixed" : sources.has("estimate") ? "estimate" : "osrm",
    rationale: input.rationale,
    droppedStops: input.droppedStops,
    createdAt: toZonedIso(input.now ?? new Date(), input.timeZone),
  };
}

/** Index of the stop the group is at (or last left): the last stop whose arrival is not in the future. */
export function currentStopIndex(itinerary: Itinerary, now: Date): number {
  let index = 0;
  itinerary.stops.forEach((s, i) => {
    if (s.arriveAt && Date.parse(s.arriveAt) <= now.getTime()) index = i;
  });
  return index;
}

const shiftIso = (iso: string, minutes: number, timeZone: string) =>
  toZonedIso(new Date(Date.parse(iso) + minutes * MINUTE), timeZone);

/**
 * "We took longer at this stop": push this stop's departure and every later same-day time by `minutes`.
 * The next morning's start time absorbs the delay, so later days are unchanged.
 */
export function shiftSchedule(itinerary: Itinerary, stopId: string, minutes: number): ItineraryStop[] {
  const from = itinerary.stops.findIndex((s) => s.id === stopId);
  if (from < 0) throw new Error(`unknown stop ${stopId}`);
  const day = itinerary.stops[from]?.day;
  const tz = itinerary.timeZone;
  return itinerary.stops.map((stop, i) => {
    if (i < from || stop.day !== day) return stop;
    const next = itinerary.stops[i + 1];
    const departsSameDay = next !== undefined && next.day === day;
    const shifted = { ...stop };
    if (i > from && stop.arriveAt) shifted.arriveAt = shiftIso(stop.arriveAt, minutes, tz);
    if (departsSameDay && stop.departAt) shifted.departAt = shiftIso(stop.departAt, minutes, tz);
    if (i === from) shifted.dwellMinutes = Math.min(24 * 60, Math.max(0, stop.dwellMinutes + minutes));
    return shifted;
  });
}
