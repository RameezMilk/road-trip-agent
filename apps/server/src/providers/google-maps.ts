import type { GroundedPlace, MarkerKind, ResolvedLocation, RouteAlternative } from "@rta/contracts";
import { type Config, requireConfig } from "../config";
import { NotBuiltError } from "../errors";

/**
 * Places API (New) + Routes API only — the legacy Places/Directions APIs are unavailable to new projects.
 * Persist place IDs only; other Places content follows Google's caching and attribution rules.
 */
export interface PlacesProvider {
  resolveLocation(query: string): Promise<ResolvedLocation[]>;
  /** Route-biased discovery; it does not prove detour feasibility. */
  searchAlongRoute(input: { encodedPolyline: string; kind: MarkerKind; query: string }): Promise<GroundedPlace[]>;
}

export interface RoutesProvider {
  computeRoute(input: { stops: ResolvedLocation[]; departAt: string }): Promise<RouteAlternative>;
}

export function createGoogleMaps(config: Config): PlacesProvider & RoutesProvider {
  requireConfig(config, "Google Maps", ["GOOGLE_MAPS_SERVER_KEY"]);
  throw new NotBuiltError("Google Places/Routes");
}
