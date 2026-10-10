import { z } from "zod";

export const MarkerKind = z.enum(["restaurant", "rest", "hotel", "scenic", "attraction", "charging"]);
export type MarkerKind = z.infer<typeof MarkerKind>;

/** `/vote … clear` maps to `abstain`; a missing vote is no record at all (pending). */
export const VoteState = z.enum(["like", "pass", "must", "abstain"]);
export type VoteState = z.infer<typeof VoteState>;

export const CommandName = z.enum([
  "trip",
  "join",
  "inspire",
  "plan",
  "vote",
  "confirm",
  "approve",
  "map",
  "done",
  "replan",
  "status",
  "help",
  "cancel",
]);
export type CommandName = z.infer<typeof CommandName>;

/** Main path DRAFT → … → ACTIVE; the last five are branches. */
export const TripStatus = z.enum([
  "DRAFT",
  "PLANNING",
  "VOTING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "CONFIRMED",
  "ACTIVE",
  "REPLANNING",
  "NEEDS_INPUT",
  "NO_FEASIBLE_PLAN",
  "TOOLS_UNAVAILABLE",
  "CANCELED",
]);
export type TripStatus = z.infer<typeof TripStatus>;

export const VehicleMode = z.enum(["gas", "ev_tesla"]);
export const ConstraintKind = z.enum(["dietary", "accessibility", "time", "budget", "vehicle"]);
