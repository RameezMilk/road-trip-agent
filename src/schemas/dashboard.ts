import { z } from "zod";
import { Itinerary } from "./itinerary";
import { IsoDateTime, PublicId } from "./primitives";
import { TripPhase } from "./trip";

/**
 * Public, read-only view served to the dashboard page. Anyone holding the card link can read it,
 * so it carries first names and group-level aggregates only: no handles, no per-person requirements,
 * and no record of who voted for what.
 */
export const TripDashboard = z.strictObject({
  publicId: PublicId,
  title: z.string(),
  phase: TripPhase,
  members: z.array(z.strictObject({ name: z.string(), approved: z.boolean() })),
  itinerary: Itinerary.omit({ tripId: true }).nullable(),
  decisions: z.array(
    z.strictObject({ question: z.string(), winningLabel: z.string(), votes: z.int(), voters: z.int() }),
  ),
  updatedAt: IsoDateTime,
});
export type TripDashboard = z.infer<typeof TripDashboard>;
