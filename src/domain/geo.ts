import type { LatLng, RouteLeg } from "../schemas";

const EARTH_RADIUS_M = 6_371_000;
export const METERS_PER_MILE = 1609.344;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Road-distance guess when OSRM is unreachable: straight line × 1.25 at 50 mph. Always labeled "estimate". */
export function estimateLeg(from: { id: string; latLng: LatLng }, to: { id: string; latLng: LatLng }): RouteLeg {
  const distanceMeters = Math.round(haversineMeters(from.latLng, to.latLng) * 1.25);
  const durationSeconds = Math.round((distanceMeters / METERS_PER_MILE / 50) * 3600);
  return {
    fromStopId: from.id,
    toStopId: to.id,
    distanceMeters,
    durationSeconds,
    source: "estimate",
    geometry: [
      [from.latLng.lat, from.latLng.lng],
      [to.latLng.lat, to.latLng.lng],
    ],
  };
}
