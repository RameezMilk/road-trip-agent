import { describe, expect, it } from "vitest";
import type { ItineraryDraft, LatLng, ResolvedRequirements, RouteLeg } from "../schemas";
import { FakeLlm } from "../testing/fakes";
import type { Geocoder, Router } from "./geo";
import { Planner } from "./planner";

// Places on a line: each 0.1° of longitude is one hour of driving, so schedules are easy to read.
const COORDS: Record<string, LatLng> = {
  "Chapel Hill, NC": { lat: 35, lng: -79 },
  "Museum, Town, NC": { lat: 35, lng: -78.9 },
  "Lunch Spot, Town, NC": { lat: 35, lng: -78.85 },
  "Beach Town, NC": { lat: 35, lng: -78.6 },
  "Far Beach, NC": { lat: 35, lng: -78.5 },
};
const geocoder: Geocoder = {
  geocode: async (q) => ({ latLng: COORDS[q] ?? (COORDS["Beach Town, NC"] as LatLng), displayName: q }),
  townAt: async () => "Benson, NC",
};
const router: Router = {
  route: async (points) =>
    points.slice(1).map((p, i): RouteLeg => {
      const a = points[i] as (typeof points)[number];
      const hours = Math.abs(p.latLng.lng - a.latLng.lng) / 0.1;
      return {
        fromStopId: a.id,
        toStopId: p.id,
        distanceMeters: Math.round(hours * 100_000),
        durationSeconds: Math.round(hours * 3600),
        source: "osrm",
        geometry: Array.from({ length: 11 }, (_, k) => [35, a.latLng.lng + ((p.latLng.lng - a.latLng.lng) * k) / 10]),
      };
    }),
};
const resolved = (endLocation: string): ResolvedRequirements => ({
  startLocation: "Chapel Hill, NC",
  endLocation,
  tripType: "one_way",
  startDate: "2026-10-17",
  endDate: "2026-10-17",
  budgetPerPersonUsd: 300,
  dietaryRestrictions: [],
  adopted: [],
  decisions: [],
});
const draftStop = (name: string, kind: string, dwellMinutes: number, addressQuery: string) => ({
  name,
  kind,
  addressQuery,
  city: "Town, NC",
  dwellMinutes,
  note: "",
  sustainable: false,
  sourceUrl: null,
  estCostPerPersonUsd: null,
});
const draft = (stops: ReturnType<typeof draftStop>[]): ItineraryDraft =>
  ({ title: "Day trip", rationale: "", days: [{ day: 1, departTime: "09:00", stops }] }) as ItineraryDraft;
const input = (endLocation: string) => ({
  tripId: "trip_test",
  version: 1,
  title: "Day trip",
  timeZone: "America/New_York",
  resolved: resolved(endLocation),
  memberCount: 2,
});

describe("Planner: planning for people", () => {
  it("sends a draft with no lunch back once, with the exact problem, and keeps the fixed one", async () => {
    const llm = new FakeLlm().on(
      "itinerary_draft",
      // Museum 10 AM–2:30 PM, beach at 3:30: nobody eats lunch.
      draft([
        draftStop("Museum", "attraction", 270, "Museum, Town, NC"),
        draftStop("Beach Town, NC", "destination", 0, "Beach Town, NC"),
      ]),
      draft([
        draftStop("Museum", "attraction", 120, "Museum, Town, NC"),
        draftStop("Lunch Spot", "restaurant", 45, "Lunch Spot, Town, NC"),
        draftStop("Beach Town, NC", "destination", 0, "Beach Town, NC"),
      ]),
    );
    const planner = new Planner({ llm, geocoder, router, vehicleMpg: 30, gasPriceUsdPerGallon: 3.2 });
    const itinerary = await planner.draft(input("Beach Town, NC"));
    const drafts = llm.calls.filter((c) => c.task === "itinerary_draft");
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.prompt).toContain("takes about 4h 00m one way"); // the real drive time, up front
    expect(drafts[1]?.prompt).toContain("no lunch stop");
    expect(itinerary.stops.map((s) => s.name)).toContain("Lunch Spot");
  });

  it("adds a stretch break on a long drive, named after the town on the route", async () => {
    const llm = new FakeLlm().on(
      "itinerary_draft",
      draft([
        draftStop("Lunch Spot", "restaurant", 45, "Lunch Spot, Town, NC"),
        draftStop("Far Beach, NC", "destination", 0, "Far Beach, NC"),
      ]),
    );
    const planner = new Planner({ llm, geocoder, router, vehicleMpg: 30, gasPriceUsdPerGallon: 3.2 });
    const itinerary = await planner.draft(input("Far Beach, NC"));
    // Chapel Hill → lunch 1.5 h, then 3.5 h to the beach: one 15-minute break splits it.
    expect(itinerary.stops.map((s) => [s.name, s.kind])).toEqual([
      ["Chapel Hill, NC", "origin"],
      ["Lunch Spot", "restaurant"],
      ["Stretch break near Benson, NC", "rest_stop"],
      ["Far Beach, NC", "destination"],
    ]);
    expect(itinerary.stops[2]?.dwellMinutes).toBe(15);
    expect(llm.calls.filter((c) => c.task === "itinerary_draft")).toHaveLength(1); // no repair needed
  });
});
