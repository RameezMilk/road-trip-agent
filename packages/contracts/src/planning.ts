import { z } from "zod";
import { MarkerKind, VehicleMode } from "./enums";
import {
  CandidateId,
  EventId,
  IsoDateTime,
  ParticipantId,
  PlanVersion,
  Seconds,
  StopId,
  TripId,
  Usd,
} from "./primitives";

/**
 * Gemini's selection output. It may only reference candidate IDs it was given; that subset check needs the
 * candidate list, so it lives in the server's validator, not here.
 */
export const StructuredPlan = z.strictObject({
  tripId: TripId,
  planVersion: PlanVersion,
  orderedCandidateIds: z.array(CandidateId).max(8),
  reasons: z.array(z.strictObject({ candidateId: CandidateId, text: z.string().min(1).max(140) })).max(8),
  unresolvedQuestions: z.array(z.string().min(1).max(200)).max(5),
});
export type StructuredPlan = z.infer<typeof StructuredPlan>;

export const FeasibilityCheck = z.strictObject({
  name: z.enum([
    "arrival_deadline",
    "extra_drive_limit",
    "opening_at_arrival",
    "budget",
    "dietary",
    "accessibility",
    "ev_range",
    "charger_compatibility",
    "stop_count",
  ]),
  status: z.enum(["passed", "failed", "unverified"]),
  detail: z.string().min(1).max(200),
  candidateId: CandidateId.nullable(),
});

/** Computed in code, never asserted by an LLM. */
export const FeasibilityResult = z
  .strictObject({
    tripId: TripId,
    planVersion: PlanVersion,
    checks: z.array(FeasibilityCheck),
    totalDriveSeconds: Seconds,
    totalStopSeconds: Seconds,
    departAt: IsoDateTime,
    projectedArrivalAt: IsoDateTime,
    feasible: z.boolean(),
  })
  .refine((r) => !r.feasible || r.checks.every((c) => c.status !== "failed"), {
    message: "A plan with a failed check cannot be feasible",
    path: ["feasible"],
  });
export type FeasibilityResult = z.infer<typeof FeasibilityResult>;

export const CostEnergyEstimate = z.strictObject({
  scope: z.array(z.enum(["fuel", "charging", "meals", "paid_stops"])).min(1),
  currency: z.literal("USD"),
  routeMiles: z.number().nonnegative(),
  vehicleMode: VehicleMode,
  mpg: z.number().positive().nullable(),
  whPerMile: z.number().positive().nullable(),
  energyPriceBasis: z
    .strictObject({
      kind: z.enum(["usd_per_gallon", "usd_per_kwh"]),
      value: Usd,
      source: z.string().min(1).max(200),
    })
    .nullable(),
  gallons: z.number().nonnegative().nullable(),
  kWh: z.number().nonnegative().nullable(),
  conservativeMarginPct: z.number().min(0).max(100),
  estimatedUsd: z.strictObject({ low: Usd, high: Usd }).nullable(),
  /** A feasible plan serving the same chosen stops and requirements. */
  baseline: z
    .strictObject({
      label: z.string().min(1).max(120),
      routeMiles: z.number().nonnegative(),
      estimatedUsd: Usd.nullable(),
      gallons: z.number().nonnegative().nullable(),
      kWh: z.number().nonnegative().nullable(),
    })
    .nullable(),
  unknowns: z.array(z.string().min(1).max(200)).max(10),
});
export type CostEnergyEstimate = z.infer<typeof CostEnergyEstimate>;

/** Immutable once written; a change creates a new version. Approval binds to this exact version. */
export const ItineraryVersion = z.strictObject({
  tripId: TripId,
  version: PlanVersion,
  status: z.enum(["proposed", "approved", "superseded", "rejected"]),
  stops: z.array(
    z.strictObject({
      stopId: StopId,
      kind: z.union([MarkerKind, z.enum(["origin", "destination"])]),
      completedAt: IsoDateTime.nullable(),
    }),
  ),
  decisionRefs: z.array(EventId),
  approval: z.strictObject({ participantId: ParticipantId, approvedAt: IsoDateTime }).nullable(),
  createdAt: IsoDateTime,
});
export type ItineraryVersion = z.infer<typeof ItineraryVersion>;
