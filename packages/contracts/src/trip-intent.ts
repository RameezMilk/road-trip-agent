import { z } from "zod";
import { ConstraintKind, MarkerKind, VehicleMode } from "./enums";
import { IanaTimeZone, IsoDateTime, LocalDate, Minutes, Usd } from "./primitives";

export const TripIntentField = z.enum([
  "origin",
  "destination",
  "date",
  "timeZone",
  "departAt",
  "latestArrivalAt",
  "maxExtraDriveMinutes",
  "stopTimeAllowanceMinutes",
  "mealSpend",
  "vehicle",
]);

/** A requested constraint becomes hard only once `confirmed` by the group. */
export const TripConstraint = z.strictObject({
  kind: ConstraintKind,
  detail: z.string().min(1).max(200),
  confirmed: z.boolean(),
});

export const MealSpend = z.strictObject({
  scope: z.enum(["per_person", "group"]),
  amountUsd: Usd,
  /** A strict ceiling can't be certified by unknown prices; a soft target can. */
  strictness: z.enum(["soft", "strict"]),
});

/** Declared assumptions, never telemetry. Flat (no union) so it maps cleanly to a structured-output schema. */
export const VehicleAssumptions = z.strictObject({
  mode: VehicleMode,
  mpg: z.number().positive().max(150).nullable(),
  usableKwh: z.number().positive().max(200).nullable(),
  startSocPct: z.number().min(0).max(100).nullable(),
  whPerMile: z.number().positive().max(1000).nullable(),
  reservePct: z.number().min(0).max(100).nullable(),
  connector: z.enum(["nacs", "ccs1_with_adapter"]).nullable(),
});

/** What Gemini extracts from chat/inspiration; humans confirm anything ambiguous before planning. */
export const TripIntent = z.strictObject({
  originQuery: z.string().min(1).max(200).nullable(),
  destinationQuery: z.string().min(1).max(200).nullable(),
  date: LocalDate.nullable(),
  timeZone: IanaTimeZone.nullable(),
  departAt: IsoDateTime.nullable(),
  latestArrivalAt: IsoDateTime.nullable(),
  maxExtraDriveMinutes: Minutes.nullable(),
  stopTimeAllowanceMinutes: Minutes.nullable(),
  mealSpend: MealSpend.nullable(),
  desiredKinds: z.array(MarkerKind).max(6),
  constraints: z.array(TripConstraint).max(20),
  vehicle: VehicleAssumptions.nullable(),
  missingFields: z.array(TripIntentField),
});
export type TripIntent = z.infer<typeof TripIntent>;
