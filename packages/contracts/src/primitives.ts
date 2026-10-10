import { z } from "zod";

/** ISO 8601 timestamp that must carry a UTC offset ("Z" or ±hh:mm) — never a floating local time. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export const LocalDate = z.iso.date();
export const IanaTimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA time zone");

export const LatLng = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const Meters = z.number().int().nonnegative();
export const Seconds = z.number().int().nonnegative();
export const Minutes = z
  .number()
  .int()
  .nonnegative()
  .max(24 * 60);
export const Usd = z.number().nonnegative().max(100_000);
export const PlanVersion = z.number().int().positive();

const prefixedId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{6,64}$`));
export const TripId = prefixedId("trip");
export const ParticipantId = prefixedId("part");
export const CandidateId = prefixedId("cand");
export const LocationId = prefixedId("loc");
export const EventId = prefixedId("evt");
/** A stop on an itinerary: a resolved origin/destination location or a candidate. */
export const StopId = z.union([LocationId, CandidateId]);

/** Where a fact came from. Facts without a source stay unknown. */
export const SourceRef = z.strictObject({
  provider: z.enum(["google_places", "google_routes", "snowflake_corpus", "user"]),
  ref: z.string().min(1).max(500),
  url: z.url().nullable(),
});
