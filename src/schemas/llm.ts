import { z } from "zod";
import { OptionalCategory, TripType } from "./requirements";

/*
 * Schemas Gemini must fill. Rules (Gemini's JSON-schema subset, and "LLM output is untrusted"):
 * - flat objects only: a `kind` enum plus nullable fields, never discriminated unions (they emit `oneOf`);
 * - no regex / refinements (dropped or unsupported) — formats are re-validated in code after parsing;
 * - IDs the model may reference are passed per call as a `z.enum([...])`, so unknown IDs fail validation.
 */

export const PredefinedExtraction = z.strictObject({
  startLocation: z.string().nullable(),
  endLocation: z.string().nullable(),
  /** YYYY-MM-DD */
  startDate: z.string().nullable(),
  /** YYYY-MM-DD */
  endDate: z.string().nullable(),
  tripType: TripType.nullable(),
  budgetPerPersonUsd: z.number().nullable(),
  /** [] when the person says they have none. */
  dietaryRestrictions: z.array(z.string()).nullable(),
});
export type PredefinedExtraction = z.infer<typeof PredefinedExtraction>;

export const OptionalExtraction = z.strictObject({
  requirements: z.array(z.strictObject({ category: OptionalCategory, text: z.string() })).max(5),
  /** The message refers to a photo that hasn't been sent yet ("similar to this" before the picture). */
  awaitingPhoto: z.boolean().default(false),
});
export type OptionalExtraction = z.infer<typeof OptionalExtraction>;

export const conflictAnalysisSchema = (requirementIds: [string, ...string[]]) => {
  const Id = z.enum(requirementIds);
  return z.strictObject({
    adoptedRequirementIds: z.array(Id),
    polls: z
      .array(
        z.strictObject({
          question: z.string(),
          options: z
            .array(z.strictObject({ label: z.string(), requirementIds: z.array(Id), resolution: z.string() }))
            .min(2)
            .max(4),
        }),
      )
      .max(3),
  });
};
export type ConflictAnalysis = z.infer<ReturnType<typeof conflictAnalysisSchema>>;

export const voteMappingSchema = (optionIds: [string, ...string[]]) =>
  z.strictObject({ optionId: z.enum(optionIds).nullable() });
export type VoteMapping = z.infer<ReturnType<typeof voteMappingSchema>>;

/** Stop kinds Gemini may propose; origin is always added by code. */
export const DraftStopKind = z.enum([
  "destination",
  "restaurant",
  "gas",
  "rest_stop",
  "lodging",
  "scenic",
  "attraction",
  "charging",
]);

export const DraftStop = z.strictObject({
  name: z.string(),
  kind: DraftStopKind,
  /** Street address or "name, city, state" — what a geocoder should search for. */
  addressQuery: z.string(),
  /** "City, ST" — fallback when the address can't be found. */
  city: z.string(),
  dwellMinutes: z.int(),
  note: z.string(),
  sustainable: z.boolean(),
  sourceUrl: z.string().nullable(),
  estCostPerPersonUsd: z.number().nullable(),
});
export type DraftStop = z.infer<typeof DraftStop>;

/** A route as typed ("chapel hil" → "wilmingtn") normalized to "City, ST". */
export const PlaceCanonicalization = z.strictObject({
  startLocation: z.string().min(2).max(120),
  endLocation: z.string().min(2).max(120),
});
export type PlaceCanonicalization = z.infer<typeof PlaceCanonicalization>;

export const ItineraryDraft = z.strictObject({
  title: z.string(),
  rationale: z.string(),
  days: z
    .array(
      z.strictObject({
        day: z.int(),
        /** HH:MM local departure time for the day's first leg. */
        departTime: z.string(),
        stops: z.array(DraftStop).max(10),
      }),
    )
    .min(1)
    .max(14),
});
export type ItineraryDraft = z.infer<typeof ItineraryDraft>;

export const FeedbackImpact = z.enum(["minor", "material", "conflicting"]);
export type FeedbackImpact = z.infer<typeof FeedbackImpact>;

export const FeedbackAssessment = z.strictObject({
  impact: FeedbackImpact,
  /** One line, shown to the group. */
  summary: z.string(),
  /** Instruction for the replanner when impact is minor or material. */
  instruction: z.string(),
  /** Only when impact is conflicting. */
  pollQuestion: z.string().nullable(),
  pollOptions: z.array(z.strictObject({ label: z.string(), instruction: z.string() })).max(3),
  /** The feedback refers to a photo that hasn't been sent yet; wait for it instead of replanning. */
  awaitingPhoto: z.boolean().default(false),
});
export type FeedbackAssessment = z.infer<typeof FeedbackAssessment>;

export const LiveUpdateKind = z.enum(["delay", "replace_stop", "add_stop", "replan_remaining", "none"]);

export const liveUpdateSchema = (stopIds: [string, ...string[]]) =>
  z.strictObject({
    kind: LiveUpdateKind,
    delayMinutes: z.int().nullable(),
    stopId: z.enum(stopIds).nullable(),
    /** What the group wants instead, or what to add (replace_stop / add_stop / replan_remaining). */
    request: z.string().nullable(),
    /** Reply for kind "none" (questions, chit-chat). */
    reply: z.string().nullable(),
  });
export type LiveUpdate = z.infer<ReturnType<typeof liveUpdateSchema>>;

export const ImageKind = z.enum(["place", "scene", "unrelated"]);

/** What a member's photo shows: a specific place to visit, a kind of spot to find more of, or neither. */
export const ImageInterpretation = z.strictObject({
  kind: ImageKind,
  /** place only: the place's name as shown. */
  placeName: z.string().nullable(),
  /** place only: "City, ST" when known. */
  city: z.string().nullable(),
  /** One line describing what the image shows (for scene: the searchable qualities). */
  description: z.string(),
  category: OptionalCategory,
});
export type ImageInterpretation = z.infer<typeof ImageInterpretation>;

export const ReplacementStop = z.strictObject({ stop: DraftStop, summary: z.string() });
export type ReplacementStop = z.infer<typeof ReplacementStop>;

/**
 * JSON Schema for Gemini's `response_format.schema`. Array-length bounds (`minItems`/`maxItems`) are
 * stripped: Gemini rejects them on nested arrays (HTTP 400, seen live on ItineraryDraft). Zod still
 * enforces every bound on the parsed result, so an over-long answer fails validation and is repaired.
 */
export function toLlmJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw" }) as Record<string, unknown>;
  delete json.$schema;
  return stripArrayBounds(json) as Record<string, unknown>;
}

function stripArrayBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripArrayBounds);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "minItems" || key === "maxItems") continue;
    out[key] = stripArrayBounds(value);
  }
  return out;
}
