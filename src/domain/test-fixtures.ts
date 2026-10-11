import type { ResolvedRequirements, RouteLeg } from "../schemas";
import { estimateLeg } from "./geo";
import type { PlacedStop } from "./schedule";

// Test-only fixtures (Chapel Hill → Asheville). Never imported by runtime code.

export const RESOLVED: ResolvedRequirements = {
  startLocation: "Chapel Hill, NC",
  endLocation: "Asheville, NC",
  startDate: "2026-10-17",
  endDate: "2026-10-18",
  tripType: "one_way",
  budgetPerPersonUsd: 150,
  dietaryRestrictions: ["halal"],
  adopted: [],
  decisions: [],
};

const stop = (
  id: string,
  day: number,
  kind: PlacedStop["kind"],
  name: string,
  lat: number,
  lng: number,
  dwell: number,
): PlacedStop => ({
  id,
  day,
  kind,
  name,
  address: null,
  latLng: { lat, lng },
  geocodeSource: "nominatim",
  dwellMinutes: dwell,
  note: null,
  sustainable: kind === "scenic",
  sourceUrl: null,
  webEstimateCostPerPersonUsd: kind === "restaurant" ? 20 : null,
});

export const PLACED: PlacedStop[] = [
  stop("stop_origin000000001", 1, "origin", "Chapel Hill, NC", 35.9132, -79.0558, 0),
  stop("stop_lunch0000000001", 1, "restaurant", "Halal Grill", 36.0726, -79.792, 60),
  stop("stop_hotel0000000001", 1, "lodging", "Boone Inn", 36.2168, -81.6746, 0),
  stop("stop_scenic000000001", 2, "scenic", "Blue Ridge Overlook", 35.6, -82.3, 45),
  stop("stop_dest00000000001", 2, "destination", "Asheville, NC", 35.5951, -82.5515, 0),
];

export const LEGS: RouteLeg[] = PLACED.slice(1).map((s, i) => {
  const prev = PLACED[i] as PlacedStop;
  return { ...estimateLeg(prev, s), durationSeconds: 3600, source: "osrm" as const };
});
