import { z } from "zod";
import { haversineMeters } from "../domain/geo";
import { alignMeals, breakPoints, scheduleIssues, stretchBreak } from "../domain/humane";
import { buildItinerary, finalizeItinerary, type PlacedStop, rescheduleFrom } from "../domain/schedule";
import { daysBetween, formatDuration } from "../domain/time";
import {
  type DraftStop,
  type Itinerary,
  ItineraryDraft,
  type ItineraryStop,
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
  /**
   * Plan for people (default on): stretch breaks on long drives, meals moved to mealtimes, and one Gemini
   * repair round for whatever still breaks a rule (`domain/humane`). Off in tests that pin exact schedules.
   */
  humane?: boolean;
  log?: (event: string, data?: Record<string, unknown>) => void;
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

const HttpUrl = z.url({ protocol: /^https?$/ });

/** Gemini picks places (grounded by Google Search); OSM locates them; OSRM + code compute every number. */
export class Planner {
  /** One-way drive time per start|end, so Gemini can put meals and breaks at the right hours. */
  private readonly driveHints = new Map<string, Promise<string>>();

  constructor(private readonly deps: PlannerDeps) {}

  tripDays(resolved: ResolvedRequirements): number {
    return Math.min(14, Math.max(1, daysBetween(resolved.startDate, resolved.endDate) + 1));
  }

  async draft(input: DraftInput): Promise<Itinerary> {
    return this.placeChecked(input, await this.research(input));
  }

  /**
   * Places a researched draft, then checks the real schedule (OSRM times) against human needs: meals at
   * mealtimes and not back to back, a break at least every ~2 h, about 8 h of driving a day at most, no
   * night driving (`domain/humane`). Problems get one repair round with Gemini, given the exact issues;
   * the version with fewer problems wins.
   */
  async placeChecked(input: DraftInput, draft: ItineraryDraft): Promise<Itinerary> {
    const placed = await this.place(input, draft);
    if (this.deps.humane === false) return placed;
    const issues = scheduleIssues(placed);
    if (!issues.length) return placed;
    const log = this.deps.log ?? (() => {});
    log("schedule_issues", { tripId: input.tripId, count: issues.length, issues });
    try {
      const instruction = [
        "Fix these schedule problems (found on the real drive times):",
        ...issues.map((i) => `- ${i}`),
        "Keep the route, dates and the stops that work; move, swap or add stops only as needed.",
        'Leave out the stops named "Stretch break …": code adds those on long drives.',
      ].join("\n");
      const repaired = await this.place(
        input,
        await this.research({ ...input, revision: { previous: placed, instruction } }),
      );
      const after = scheduleIssues(repaired);
      log("schedule_repaired", { tripId: input.tripId, before: issues.length, after: after.length, issues: after });
      return after.length < issues.length ? repaired : placed;
    } catch (error) {
      log("schedule_repair_failed", { tripId: input.tripId, error: String(error) });
      return placed;
    }
  }

  /** The slow part: Gemini + Google Search picks the places. The engine may run it speculatively. */
  async research(input: DraftInput): Promise<ItineraryDraft> {
    const { resolved } = input;
    const days = this.tripDays(resolved);
    const revision = input.revision
      ? `\n\nCurrent itinerary:\n${itineraryBlock(input.revision.previous)}\n\nRequested change: ${input.revision.instruction}\nKeep everything else as it is unless the change requires otherwise.`
      : "";
    const drive = await this.driveHint(resolved);
    return this.deps.llm.generate({
      task: "itinerary_draft",
      system: SYSTEM.itineraryDraft,
      prompt: `Plan this group road trip.\n${requirementsBlock(resolved, days)}${drive}${revision}`,
      schema: ItineraryDraft,
      webSearch: true,
    });
  }

  /**
   * "Driving A → B takes about 3h 25m": the real one-way drive (one OSRM call, cached), so the draft puts
   * meals and breaks at the right hours instead of guessing. Empty if either end can't be located.
   */
  private driveHint(resolved: ResolvedRequirements): Promise<string> {
    const key = `${resolved.startLocation}|${resolved.endLocation}`;
    let hint = this.driveHints.get(key);
    if (!hint) {
      hint = (async () => {
        const [a, b] = await Promise.all([
          this.deps.geocoder.geocode(resolved.startLocation),
          this.deps.geocoder.geocode(resolved.endLocation),
        ]);
        if (!a || !b) return "";
        const [leg] = await this.deps.router.route([
          { id: "stop_start", latLng: a.latLng },
          { id: "stop_end", latLng: b.latLng },
        ]);
        return leg
          ? `\nDriving ${resolved.startLocation} → ${resolved.endLocation} takes about ${formatDuration(leg.durationSeconds)} one way without stops (real routing): plan meals and breaks around it.`
          : "";
      })().catch(() => "");
      this.driveHints.set(key, hint);
    }
    return hint;
  }

  /** Locates the researched stops (in parallel), routes them, and computes the schedule and totals. */
  async place(input: DraftInput, draft: ItineraryDraft): Promise<Itinerary> {
    const { resolved } = input;
    const days = this.tripDays(resolved);
    const dayDepartTimes = new Map<number, string>();
    const wanted: Array<{ stop: DraftStop; day: number }> = [];
    for (const plan of [...draft.days].sort((a, b) => a.day - b.day)) {
      const day = Math.min(days, Math.max(1, plan.day));
      if (!dayDepartTimes.has(day)) dayDepartTimes.set(day, LocalTime.safeParse(plan.departTime).data ?? "09:00");
      for (const stop of plan.stops) wanted.push({ stop, day });
    }
    const candidates = wanted;
    const [origin, ...located] = await Promise.all([
      this.deps.geocoder.geocode(resolved.startLocation),
      ...candidates.map(({ stop, day }) => this.locate(stop, day)),
    ]);
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
    candidates.forEach(({ stop }, i) => {
      const hit = located[i];
      if (hit) placed.push(hit);
      else if (!hit) dropped.push(stop.name);
    });

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

    let legs = await this.deps.router.route(placed);
    if (this.deps.humane !== false) {
      // Long stretches without a stop (often the drive home) get a stretch break on the real route.
      const breaks = breakPoints(placed, legs);
      if (breaks.length) {
        const towns = await Promise.all(
          breaks.map((b) => this.deps.geocoder.townAt?.(b.latLng).catch(() => null) ?? Promise.resolve(null)),
        );
        const order = breaks.map((b, k) => ({ ...b, town: towns[k] ?? null }));
        order.sort((a, b) => b.afterIndex - a.afterIndex || b.order - a.order);
        for (const b of order) placed.splice(b.afterIndex + 1, 0, stretchBreak(newId("stop"), b, b.town));
        legs = await this.deps.router.route(placed);
      }
    }
    const built = buildItinerary({
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
    if (this.deps.humane === false) return built;
    // An early meal waits for its mealtime (linger at the previous activity / leave a bit later).
    return finalizeItinerary({
      ...built,
      resolved,
      stops: alignMeals(built.stops, built.legs, built.timeZone),
      memberCount: input.memberCount,
      vehicleMpg: this.deps.vehicleMpg,
      gasPriceUsdPerGallon: this.deps.gasPriceUsdPerGallon,
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

  /**
   * Adds one stop to the rest of a trip that's underway (a place from a photo, or "add a stop at …"):
   * Gemini finds the real place with Google Search, OSM locates it, and it goes between the two stops still
   * ahead where it adds the least driving. Times from there on are recomputed; nothing is dropped.
   */
  async addStop(input: {
    itinerary: Itinerary;
    request: string;
    /** Index of the stop the group is at now; the new stop goes after it. */
    after: number;
    resolved: ResolvedRequirements;
    memberCount: number;
    version: number;
  }): Promise<{ itinerary: Itinerary; stop: ItineraryStop; summary: string }> {
    const { itinerary } = input;
    const first = Math.max(1, input.after + 1);
    if (first >= itinerary.stops.length) throw new PlanningError("there are no stops left on this trip to add it to.");
    const ahead = itinerary.stops.slice(first - 1).map((s) => `[${s.id}] ${s.name} (day ${s.day})`);
    const result = await this.deps.llm.generate({
      task: "added_stop",
      system: SYSTEM.addedStop,
      prompt: `${requirementsBlock(input.resolved, this.tripDays(input.resolved))}\n\n${itineraryBlock(itinerary)}\n\nThe group is at or past "${itinerary.stops[first - 1]?.name}". Stops still ahead:\n${ahead.join("\n")}\n\nAdd: ${input.request}`,
      schema: ReplacementStop,
      webSearch: true,
    });
    const draft = { ...result.stop, kind: result.stop.kind === "destination" ? "attraction" : result.stop.kind };
    const located = await this.locate(draft as DraftStop, 1);
    if (!located) throw new PlanningError(`I couldn't find "${result.stop.name}" on the map.`);

    // Cheapest insertion among the legs still ahead (straight-line detour; OSRM then times the real route).
    let at = first;
    let best = Number.POSITIVE_INFINITY;
    for (let i = first; i < itinerary.stops.length; i++) {
      const a = (itinerary.stops[i - 1] as ItineraryStop).latLng;
      const b = (itinerary.stops[i] as ItineraryStop).latLng;
      const extra = haversineMeters(a, located.latLng) + haversineMeters(located.latLng, b) - haversineMeters(a, b);
      if (extra < best) [best, at] = [extra, i];
    }
    const before = itinerary.stops[at - 1] as ItineraryStop;
    const stop: ItineraryStop = {
      ...located,
      day: (itinerary.stops[at] as ItineraryStop).day,
      arriveAt: before.departAt,
      departAt: before.departAt,
    };
    const stops = [...itinerary.stops.slice(0, at), stop, ...itinerary.stops.slice(at)];
    const legs = await this.deps.router.route(stops);
    const timed = rescheduleFrom(stops, legs, at, itinerary.timeZone);
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
      stop: timed[at] as ItineraryStop,
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
