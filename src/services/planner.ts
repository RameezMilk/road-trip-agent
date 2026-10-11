import { z } from "zod";
import { buildItinerary, finalizeItinerary, type PlacedStop, rescheduleFrom } from "../domain/schedule";
import { daysBetween } from "../domain/time";
import {
  type DraftStop,
  type Itinerary,
  ItineraryDraft,
  LocalTime,
  newId,
  ReplacementStop,
  type ResolvedRequirements,
  Usd,
} from "../schemas";
import type { Geocoder, Router } from "./geo";
import type { Llm } from "./llm";
import { itineraryBlock, requirementsBlock, SYSTEM } from "./prompts";

export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningError";
  }
}

export interface PlannerDeps {
  llm: Llm;
  geocoder: Geocoder;
  router: Router;
  vehicleMpg: number;
  gasPriceUsdPerGallon: number;
  /** Cap on planned stops (fewer stops = faster draft and fewer geocoding calls at 1 req/s). */
  maxStops?: number;
}

export interface DraftInput {
  tripId: string;
  version: number;
  title: string;
  timeZone: string;
  resolved: ResolvedRequirements;
  memberCount: number;
  /** Set when revising: the current itinerary plus what to change. */
  revision?: { previous: Itinerary; instruction: string };
}

const DEFAULT_MAX_STOPS = 12;
const HttpUrl = z.url({ protocol: /^https?$/ });

/** Gemini picks places (grounded by Google Search); OSM locates them; OSRM + code compute every number. */
export class Planner {
  private readonly maxStops: number;

  constructor(private readonly deps: PlannerDeps) {
    this.maxStops = deps.maxStops ?? DEFAULT_MAX_STOPS;
  }

  tripDays(resolved: ResolvedRequirements): number {
    return Math.min(14, Math.max(1, daysBetween(resolved.startDate, resolved.endDate) + 1));
  }

  async draft(input: DraftInput): Promise<Itinerary> {
    const { resolved } = input;
    const days = this.tripDays(resolved);
    const revision = input.revision
      ? `\n\nCurrent itinerary:\n${itineraryBlock(input.revision.previous)}\n\nRequested change: ${input.revision.instruction}\nKeep everything else as it is unless the change requires otherwise.`
      : "";
    const draft = await this.deps.llm.generate({
      task: "itinerary_draft",
      system: SYSTEM.itineraryDraft(this.maxStops),
      prompt: `Plan this group road trip.\n${requirementsBlock(resolved, days)}${revision}`,
      schema: ItineraryDraft,
      webSearch: true,
    });

    const origin = await this.deps.geocoder.geocode(resolved.startLocation);
    if (!origin) throw new PlanningError(`I couldn't find "${resolved.startLocation}" on the map.`);
    const originStop: PlacedStop = {
      id: newId("stop"),
      day: 1,
      kind: "origin",
      name: resolved.startLocation,
      address: origin.displayName.slice(0, 240),
      latLng: origin.latLng,
      geocodeSource: "nominatim",
      dwellMinutes: 0,
      note: null,
      sustainable: false,
      sourceUrl: null,
      webEstimateCostPerPersonUsd: null,
    };

    const placed: PlacedStop[] = [originStop];
    const dropped: string[] = [];
    const dayDepartTimes = new Map<number, string>();
    let count = 0;
    for (const plan of [...draft.days].sort((a, b) => a.day - b.day)) {
      const day = Math.min(days, Math.max(1, plan.day));
      if (!dayDepartTimes.has(day)) dayDepartTimes.set(day, LocalTime.safeParse(plan.departTime).data ?? "09:00");
      for (const stop of plan.stops) {
        if (count >= this.maxStops) break;
        const located = await this.locate(stop, day);
        if (located) {
          placed.push(located);
          count++;
        } else dropped.push(stop.name);
      }
    }

    const lastDay = Math.max(...placed.map((s) => s.day));
    if (!placed.some((s) => s.kind === "destination")) {
      const end = await this.deps.geocoder.geocode(resolved.endLocation);
      if (!end) throw new PlanningError(`I couldn't find "${resolved.endLocation}" on the map.`);
      placed.push({
        ...originStop,
        id: newId("stop"),
        day: lastDay,
        kind: "destination",
        name: resolved.endLocation,
        address: end.displayName.slice(0, 240),
        latLng: end.latLng,
      });
    }
    if (resolved.tripType === "round_trip") {
      placed.push({ ...originStop, id: newId("stop"), day: lastDay, name: `Home: ${resolved.startLocation}` });
    }

    const legs = await this.deps.router.route(placed);
    return buildItinerary({
      tripId: input.tripId,
      version: input.version,
      title: draft.title.trim().slice(0, 120) || input.title,
      timeZone: input.timeZone,
      resolved,
      stops: placed,
      legs,
      dayDepartTimes,
      memberCount: input.memberCount,
      vehicleMpg: this.deps.vehicleMpg,
      gasPriceUsdPerGallon: this.deps.gasPriceUsdPerGallon,
      rationale: draft.rationale.trim().slice(0, 600) || null,
      droppedStops: dropped.slice(0, 20),
    });
  }

  /** Swaps one stop for a place matching `request`, re-routes, and re-times from that stop on. */
  async replaceStop(input: {
    itinerary: Itinerary;
    stopId: string;
    request: string;
    resolved: ResolvedRequirements;
    memberCount: number;
    version: number;
  }): Promise<{ itinerary: Itinerary; summary: string }> {
    const { itinerary } = input;
    const index = itinerary.stops.findIndex((s) => s.id === input.stopId);
    const old = itinerary.stops[index];
    if (!old || index === 0) throw new PlanningError("That stop can't be replaced.");
    const result = await this.deps.llm.generate({
      task: "replacement_stop",
      system: SYSTEM.replacementStop,
      prompt: `${requirementsBlock(input.resolved, this.tripDays(input.resolved))}\n\n${itineraryBlock(itinerary)}\n\nReplace [${old.id}] "${old.name}" (${old.kind}) near ${old.latLng.lat.toFixed(4)},${old.latLng.lng.toFixed(4)}.\nRequest: ${input.request}`,
      schema: ReplacementStop,
      webSearch: true,
    });
    const located = await this.locate(result.stop, old.day);
    if (!located) throw new PlanningError(`I couldn't find "${result.stop.name}" on the map.`);
    const stops = itinerary.stops.map((s, i) =>
      i === index
        ? {
            ...located,
            kind: located.kind === "destination" ? old.kind : located.kind,
            arriveAt: s.arriveAt,
            departAt: s.departAt,
          }
        : s,
    );
    const legs = await this.deps.router.route(stops);
    const timed = rescheduleFrom(stops, legs, index, itinerary.timeZone);
    return {
      itinerary: finalizeItinerary({
        ...itinerary,
        version: input.version,
        resolved: input.resolved,
        stops: timed,
        legs,
        memberCount: input.memberCount,
        vehicleMpg: this.deps.vehicleMpg,
        gasPriceUsdPerGallon: this.deps.gasPriceUsdPerGallon,
      }),
      summary: result.summary.trim().slice(0, 200),
    };
  }

  /** Address → "name, city" → town centre (marked approximate) → give up. */
  private async locate(stop: DraftStop, day: number): Promise<PlacedStop | null> {
    const { geocoder } = this.deps;
    let source: PlacedStop["geocodeSource"] = "nominatim";
    let hit = await geocoder.geocode(stop.addressQuery);
    if (!hit) hit = await geocoder.geocode(`${stop.name}, ${stop.city}`);
    if (!hit) {
      hit = await geocoder.geocode(stop.city);
      source = "approximate";
    }
    if (!hit) return null;
    return {
      id: newId("stop"),
      day,
      kind: stop.kind,
      name: stop.name.trim().slice(0, 120) || "Stop",
      address: (source === "approximate" ? stop.city : stop.addressQuery).trim().slice(0, 240) || null,
      latLng: hit.latLng,
      geocodeSource: source,
      dwellMinutes: Math.min(720, Math.max(0, Math.round(stop.dwellMinutes))),
      note: stop.note.trim().slice(0, 280) || null,
      sustainable: stop.sustainable,
      sourceUrl: HttpUrl.safeParse(stop.sourceUrl).data ?? null,
      webEstimateCostPerPersonUsd: Usd.safeParse(stop.estCostPerPersonUsd).data ?? null,
    };
  }
}
