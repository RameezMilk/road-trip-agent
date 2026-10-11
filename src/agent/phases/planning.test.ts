import { describe, expect, it } from "vitest";
import type { PredefinedRequirements } from "../../schemas";
import { nextQuestion, openFields, parseDeterministic } from "./planning";

const empty: PredefinedRequirements = {
  startLocation: null,
  endLocation: null,
  tripType: null,
  startDate: null,
  endDate: null,
  budgetPerPersonUsd: null,
  dietaryRestrictions: null,
};
const today = "2026-10-11";

describe("route answers", () => {
  it("asks the host where from and where to; guests only where to", () => {
    expect(nextQuestion(empty, true)).toContain("Where from, and where to?");
    expect(nextQuestion(empty, false)).toBe("📍 Where to? e.g. Asheville");
    expect(nextQuestion({ ...empty, startLocation: "Chapel Hill, NC" }, false)).toBe(
      "📍 Where to? e.g. Asheville\n(leaving from Chapel Hill, NC)",
    );
    // Guests never owe a start, and nobody owes a trip type (always a round trip).
    expect(openFields(empty, false)).not.toContain("startLocation");
    expect(openFields(empty, true)).not.toContain("tripType");
  });

  it("reads 'A to B' — a guest's start is ignored, the host's start is used", () => {
    expect(parseDeterministic(empty, "Chapel Hill to Wilmington one way", today, true)).toEqual({
      startLocation: "Chapel Hill",
      endLocation: "Wilmington",
    });
    expect(parseDeterministic(empty, "Durham to Asheville", today, false)).toEqual({ endLocation: "Asheville" });
  });

  it("reads a lone place: the host's start (then the destination), a guest's destination", () => {
    expect(parseDeterministic(empty, "Chapel Hill", today, true)).toEqual({ startLocation: "Chapel Hill" });
    const from = { ...empty, startLocation: "Chapel Hill" };
    expect(nextQuestion(from, true)).toContain("where to");
    expect(parseDeterministic(from, "Myrtle Beach", today, true)).toEqual({ endLocation: "Myrtle Beach" });
    expect(parseDeterministic(empty, "asheville nc", today, false)).toEqual({ endLocation: "Asheville, NC" });
  });

  it("never takes 'one way' as a place", () => {
    expect(parseDeterministic({ ...empty, startLocation: "Wilmington" }, "One way", today, true)).toEqual({});
    expect(parseDeterministic(empty, "one way", today, false)).toEqual({});
  });
});
