import { z } from "zod";
import { LocalDate, MemberId, PollId, RequirementId, Usd } from "./primitives";

/** The requirements the agent cannot plan without, asked in this order. */
export const PredefinedField = z.enum([
  "startLocation",
  "endLocation",
  "startDate",
  "endDate",
  "tripType",
  "budgetPerPersonUsd",
  "dietaryRestrictions",
]);
export type PredefinedField = z.infer<typeof PredefinedField>;

export const TripType = z.enum(["round_trip", "one_way"]);
export type TripType = z.infer<typeof TripType>;

export const Place = z.string().trim().min(2).max(120);

/** One member's answers. `null` = not answered yet; `dietaryRestrictions: []` = answered "none". */
export const PredefinedRequirements = z.strictObject({
  startLocation: Place.nullable(),
  endLocation: Place.nullable(),
  startDate: LocalDate.nullable(),
  endDate: LocalDate.nullable(),
  tripType: TripType.nullable(),
  budgetPerPersonUsd: Usd.nullable(),
  dietaryRestrictions: z.array(z.string().trim().min(1).max(60)).max(10).nullable(),
});
export type PredefinedRequirements = z.infer<typeof PredefinedRequirements>;

export const EMPTY_PREDEFINED: PredefinedRequirements = {
  startLocation: null,
  endLocation: null,
  startDate: null,
  endDate: null,
  tripType: null,
  budgetPerPersonUsd: null,
  dietaryRestrictions: null,
};

export const OptionalCategory = z.enum([
  "food",
  "stops",
  "activities",
  "pace",
  "lodging",
  "route",
  "budget",
  "accessibility",
  "other",
]);
export type OptionalCategory = z.infer<typeof OptionalCategory>;

export const RequirementText = z.string().trim().min(2).max(200);

export const OptionalRequirement = z.strictObject({
  id: RequirementId,
  memberId: MemberId,
  category: OptionalCategory,
  text: RequirementText,
});
export type OptionalRequirement = z.infer<typeof OptionalRequirement>;

/** The group's agreed requirements once voting is done. Anonymous: no member IDs. */
export const ResolvedRequirements = z.strictObject({
  startLocation: Place,
  endLocation: Place,
  startDate: LocalDate,
  endDate: LocalDate,
  tripType: TripType,
  budgetPerPersonUsd: Usd,
  dietaryRestrictions: z.array(z.string()).max(30),
  adopted: z.array(z.strictObject({ category: OptionalCategory, text: RequirementText })).max(40),
  decisions: z
    .array(
      z.strictObject({
        pollId: PollId,
        question: z.string(),
        winningLabel: z.string(),
        votes: z.int().min(0),
        voters: z.int().min(0),
      }),
    )
    .max(20),
});
export type ResolvedRequirements = z.infer<typeof ResolvedRequirements>;
