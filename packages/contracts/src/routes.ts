import { z } from "zod";
import { IsoDateTime, Meters, Seconds, SourceRef, StopId } from "./primitives";

/** Geometry and metrics come from the routing provider only — never from the LLM. */
export const RouteLeg = z.strictObject({
  fromId: StopId,
  toId: StopId,
  distanceMeters: Meters,
  durationSeconds: Seconds,
  encodedPolyline: z.string().min(1),
  projectedArrivalAt: IsoDateTime.nullable(),
  /** Google eco routing reports fuel-equivalent microliters even for EVs — not battery kWh. */
  ecoMetric: z
    .strictObject({
      kind: z.literal("fuel_microliters_equivalent"),
      value: z.number().nonnegative(),
      source: SourceRef,
    })
    .nullable(),
  fetchedAt: IsoDateTime,
  status: z.enum(["fresh", "stale", "unavailable"]),
});
export type RouteLeg = z.infer<typeof RouteLeg>;

export const RouteAlternative = z.strictObject({
  providerRouteRef: z.string().max(500).nullable(),
  stopIds: z.array(StopId).min(2).max(27),
  legs: z.array(RouteLeg).min(1).max(26),
  totalDistanceMeters: Meters,
  totalDurationSeconds: Seconds,
  fetchedAt: IsoDateTime,
});
export type RouteAlternative = z.infer<typeof RouteAlternative>;
