import { z } from "zod";
import { estimateLeg } from "../domain/geo";
import { LatLng, type RouteLeg } from "../schemas";

export interface GeocodeResult {
  latLng: LatLng;
  displayName: string;
}

export interface Geocoder {
  geocode(query: string): Promise<GeocodeResult | null>;
}

export interface Router {
  /** One leg per consecutive pair of points. */
  route(points: Array<{ id: string; latLng: LatLng }>): Promise<RouteLeg[]>;
}

type FetchFn = typeof fetch;
type Log = (event: string, data?: Record<string, unknown>) => void;

const NominatimResults = z.array(
  z.object({ lat: z.coerce.number(), lon: z.coerce.number(), display_name: z.string() }),
);

/**
 * OpenStreetMap Nominatim. Usage policy: ≤ 1 request/second, identifying User-Agent, cache results.
 * Requests are serialised through a promise chain so concurrent callers still respect the rate limit.
 */
export class NominatimGeocoder implements Geocoder {
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly cache = new Map<string, GeocodeResult | null>();

  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly minIntervalMs = 1100,
    private readonly log: Log = () => {},
  ) {}

  geocode(query: string): Promise<GeocodeResult | null> {
    const key = query.trim().toLowerCase();
    if (!key) return Promise.resolve(null);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) ?? null);
    const run = this.chain.then(() => this.request(key, query.trim()));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async request(key: string, query: string): Promise<GeocodeResult | null> {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "us");
    try {
      const res = await this.fetchFn(url, { headers: { "User-Agent": this.userAgent, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const [hit] = NominatimResults.parse(await res.json());
      const result = hit
        ? { latLng: LatLng.parse({ lat: hit.lat, lng: hit.lon }), displayName: hit.display_name }
        : null;
      this.cache.set(key, result);
      return result;
    } catch (error) {
      this.log("geocode_failed", { query, error: String(error) });
      return null;
    }
  }
}

const OsrmResponse = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        geometry: z.object({ coordinates: z.array(z.tuple([z.number(), z.number()])) }),
        legs: z.array(z.object({ distance: z.number(), duration: z.number() })),
      }),
    )
    .optional(),
  waypoints: z.array(z.object({ waypoint_index: z.number().optional() })).optional(),
});

/**
 * OSRM public demo server: one multi-waypoint request for the whole trip. The response geometry is split
 * back into legs at the snapped waypoints. Falls back to straight-line estimates (labeled) on failure.
 */
export class OsrmRouter implements Router {
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly log: Log = () => {},
  ) {}

  async route(points: Array<{ id: string; latLng: LatLng }>): Promise<RouteLeg[]> {
    if (points.length < 2) return [];
    try {
      return await this.osrm(points);
    } catch (error) {
      this.log("route_fallback_estimate", { error: String(error) });
      return points.slice(1).map((p, i) => estimateLeg(points[i] as (typeof points)[number], p));
    }
  }

  private async osrm(points: Array<{ id: string; latLng: LatLng }>): Promise<RouteLeg[]> {
    const coords = points.map((p) => `${p.latLng.lng.toFixed(6)},${p.latLng.lat.toFixed(6)}`).join(";");
    const url = new URL(`/route/v1/driving/${coords}`, this.baseUrl);
    url.searchParams.set("overview", "simplified");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "false");
    const res = await this.fetchFn(url, { headers: { "User-Agent": this.userAgent } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = OsrmResponse.parse(await res.json());
    const route = body.routes?.[0];
    if (body.code !== "Ok" || !route || route.legs.length !== points.length - 1) throw new Error(`OSRM ${body.code}`);
    const line = route.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
    const cut = splitAtWaypoints(
      line,
      points.map((p) => p.latLng),
    );
    return route.legs.map((leg, i) => ({
      fromStopId: (points[i] as (typeof points)[number]).id,
      toStopId: (points[i + 1] as (typeof points)[number]).id,
      distanceMeters: Math.round(leg.distance),
      durationSeconds: Math.round(leg.duration),
      source: "osrm" as const,
      geometry: cut[i] ?? [],
    }));
  }
}

/** Splits a polyline into per-leg pieces at the vertices nearest each waypoint (monotonic). */
export function splitAtWaypoints(line: Array<[number, number]>, waypoints: LatLng[]): Array<Array<[number, number]>> {
  const indices: number[] = [];
  let from = 0;
  for (const wp of waypoints) {
    let best = from;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = from; i < line.length; i++) {
      const [lat, lng] = line[i] as [number, number];
      const d = (lat - wp.lat) ** 2 + (lng - wp.lng) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    indices.push(best);
    from = best;
  }
  const pieces: Array<Array<[number, number]>> = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = indices[i] ?? 0;
    const b = indices[i + 1] ?? line.length - 1;
    pieces.push(line.slice(a, Math.max(a + 1, b) + 1));
  }
  return pieces;
}
