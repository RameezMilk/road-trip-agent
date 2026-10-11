import { z } from "zod";
import { IanaTimeZone, IsoDateTime, LatLng, Meters, Minutes, Seconds, StopId, TripId, Usd } from "./primitives";
import { Place, TripType } from "./requirements";

export const StopKind = z.enum([
  "origin",
  "destination",
  "restaurant",
  "gas",
  "rest_stop",
  "lodging",
  "scenic",
  "attraction",
  "charging",
]);
export type StopKind = z.infer<typeof StopKind>;

export const GeocodeSource = z.enum(["nominatim", "approximate"]);

export const ItineraryStop = z.strictObject({
  id: StopId,
  day: z.int().min(1).max(14),
  kind: StopKind,
  name: z.string().min(1).max(120),
  address: z.string().max(240).nullable(),
  latLng: LatLng,
  /** `approximate` = only the town could be found; the map marks it. */
  geocodeSource: GeocodeSource,
  /** null for the trip's first stop. */
  arriveAt: IsoDateTime.nullable(),
  /** null for the trip's last stop. */
  departAt: IsoDateTime.nullable(),
  dwellMinutes: Minutes,
  note: z.string().max(280).nullable(),
  sustainable: z.boolean(),
  sourceUrl: z.url().nullable(),
  /** Gemini web-search estimate; always labeled as such. Never used for distances or fuel. */
  webEstimateCostPerPersonUsd: Usd.nullable(),
});
export type ItineraryStop = z.infer<typeof ItineraryStop>;

export const RouteSource = z.enum(["osrm", "estimate"]);
export type RouteSource = z.infer<typeof RouteSource>;

export const RouteLeg = z.strictObject({
  fromStopId: StopId,
  toStopId: StopId,
  distanceMeters: Meters,
  durationSeconds: Seconds,
  source: RouteSource,
  /** Simplified polyline as [lat, lng] pairs. */
  geometry: z.array(z.tuple([z.number(), z.number()])).max(5000),
});
export type RouteLeg = z.infer<typeof RouteLeg>;

export const Sustainability = z.strictObject({
  memberCount: z.int().min(1),
  vehicleMpg: z.number().positive(),
  gasPriceUsdPerGallon: z.number().positive(),
  co2KgPerGallon: z.number().positive(),
  fuelGallons: z.number().min(0),
  fuelCostUsd: Usd,
  /** If every member drove their own car the same route. */
  soloFuelGallons: z.number().min(0),
  gallonsSavedByCarpool: z.number().min(0),
  usdSavedByCarpool: Usd,
  co2KgPerPerson: z.number().min(0),
  co2KgPerPersonSolo: z.number().min(0),
  greenStops: z.int().min(0),
  totalStops: z.int().min(0),
});
export type Sustainability = z.infer<typeof Sustainability>;

export const ItineraryTotals = z.strictObject({
  distanceMeters: Meters,
  driveSeconds: Seconds,
  fuelCostPerPersonUsd: Usd,
  webEstimateStopCostPerPersonUsd: Usd,
  estimatedCostPerPersonUsd: Usd,
  budgetPerPersonUsd: Usd,
  overBudget: z.boolean(),
});
export type ItineraryTotals = z.infer<typeof ItineraryTotals>;

export const Itinerary = z.strictObject({
  tripId: TripId,
  version: z.int().min(1),
  title: z.string().min(1).max(120),
  timeZone: IanaTimeZone,
  startLocation: Place,
  endLocation: Place,
  tripType: TripType,
  stops: z.array(ItineraryStop).min(2).max(40),
  legs: z.array(RouteLeg),
  totals: ItineraryTotals,
  sustainability: Sustainability,
  routeSource: z.enum(["osrm", "estimate", "mixed"]),
  rationale: z.string().max(600).nullable(),
  /** Stops Gemini suggested that could not be located at all. */
  droppedStops: z.array(z.string()).max(20),
  createdAt: IsoDateTime,
});
export type Itinerary = z.infer<typeof Itinerary>;
