import { describe, expect, it } from "vitest";
import {
  ChatCommand,
  conflictAnalysisSchema,
  DraftStop,
  FeedbackAssessment,
  InviteCode,
  ItineraryDraft,
  liveUpdateSchema,
  newId,
  newInviteCode,
  newPollToken,
  newPublicId,
  OptionalExtraction,
  PollToken,
  PredefinedExtraction,
  PredefinedRequirements,
  PublicId,
  ReplacementStop,
  StopId,
  TripId,
  toLlmJsonSchema,
  voteMappingSchema,
} from ".";

describe("ids", () => {
  it("generates IDs that satisfy their own schemas", () => {
    expect(TripId.parse(newId("trip"))).toMatch(/^trip_/);
    expect(StopId.safeParse(newId("trip")).success).toBe(false);
    expect(PublicId.parse(newPublicId())).toHaveLength(20);
    expect(InviteCode.parse(newInviteCode())).toHaveLength(6);
    expect(PollToken.parse(newPollToken())).toHaveLength(24);
  });
});

describe("strict schemas", () => {
  it("rejects unknown keys and missing keys", () => {
    expect(ChatCommand.safeParse({ name: "ready", extra: 1 }).success).toBe(false);
    expect(
      PredefinedRequirements.safeParse({
        startLocation: "Chapel Hill, NC",
        endLocation: null,
        startDate: null,
        endDate: null,
        tripType: null,
        budgetPerPersonUsd: null,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed dates", () => {
    const base = {
      startLocation: null,
      endLocation: null,
      endDate: null,
      tripType: null,
      budgetPerPersonUsd: null,
      dietaryRestrictions: null,
    };
    expect(PredefinedRequirements.safeParse({ ...base, startDate: "2026-10-17" }).success).toBe(true);
    expect(PredefinedRequirements.safeParse({ ...base, startDate: "Oct 17" }).success).toBe(false);
  });
});

describe("LLM schemas stay inside Gemini's JSON-schema subset", () => {
  const schemas = {
    PredefinedExtraction,
    OptionalExtraction,
    ConflictAnalysis: conflictAnalysisSchema(["req_a", "req_b"]),
    VoteMapping: voteMappingSchema(["opt_a", "opt_b"]),
    DraftStop,
    ItineraryDraft,
    FeedbackAssessment,
    LiveUpdate: liveUpdateSchema(["stop_a"]),
    ReplacementStop,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} has no oneOf/$ref/pattern`, () => {
      const json = JSON.stringify(toLlmJsonSchema(schema));
      expect(json).not.toContain("oneOf");
      expect(json).not.toContain("$ref");
      expect(json).not.toContain('"pattern"');
      expect(json).not.toContain("$schema");
      expect(json).not.toMatch(/"(minItems|maxItems)"/);
    });
  }

  it("only accepts IDs it was given", () => {
    const VoteMapping = voteMappingSchema(["opt_a", "opt_b"]);
    expect(VoteMapping.safeParse({ optionId: "opt_a" }).success).toBe(true);
    expect(VoteMapping.safeParse({ optionId: "opt_zzz" }).success).toBe(false);
  });
});
