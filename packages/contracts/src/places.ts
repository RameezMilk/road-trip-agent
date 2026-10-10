import { z } from "zod";
import { MarkerKind } from "./enums";
import { CandidateId, IsoDateTime, LatLng, LocationId, SourceRef, Usd } from "./primitives";

/** Provider resolution owns these factual fields; only `providerPlaceId` may be persisted long-term. */
export const ResolvedLocation = z.strictObject({
  id: LocationId,
  providerPlaceId: z.string().min(1).max(300),
  canonicalName: z.string().min(1).max(200),
  latLng: LatLng,
  source: SourceRef,
  fetchedAt: IsoDateTime,
});
export type ResolvedLocation = z.infer<typeof ResolvedLocation>;

export const PlaceImage = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("places_photo"),
    /** Places photo names expire — fetch fresh, never persist. */
    photoName: z.string().min(1),
    authorAttributions: z.array(z.strictObject({ displayName: z.string(), uri: z.url().nullable() })),
  }),
  z.strictObject({ kind: z.literal("illustration"), markerKind: MarkerKind }),
]);

export const SourcedFact = z.strictObject({
  text: z.string().min(1).max(280),
  source: SourceRef,
});

export const PriceEstimate = z
  .strictObject({
    lowUsd: Usd,
    highUsd: Usd,
    scope: z.enum(["per_person", "per_vehicle", "group"]),
    basis: z.string().min(1).max(200),
  })
  .refine((p) => p.lowUsd <= p.highUsd, "lowUsd must be ≤ highUsd");

export const GroundedPlace = z.strictObject({
  candidateId: CandidateId,
  locationId: LocationId,
  kind: MarkerKind,
  image: PlaceImage.nullable(),
  facts: z.array(SourcedFact).max(10),
  priceEstimate: PriceEstimate.nullable(),
  /** Projected for the arrival time — "open now" is not evidence. */
  openingAtArrival: z.enum(["open", "closed", "unknown"]),
  accessStatus: z.enum(["compatible", "incompatible", "unverified"]),
  eligibility: z.enum(["eligible", "ineligible", "unverified"]),
  ineligibleReasons: z.array(z.string().min(1).max(200)).max(10),
});
export type GroundedPlace = z.infer<typeof GroundedPlace>;
