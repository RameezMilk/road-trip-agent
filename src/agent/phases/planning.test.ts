import { describe, expect, it } from "vitest";
import type { PredefinedRequirements } from "../../schemas";
import { nextQuestion, parseDeterministic } from "./planning";

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
  it("reads a lone place as the destination, then asks only for the start", () => {
    const found = parseDeterministic(empty, "Wilmington", today);
    expect(found).toEqual({ endLocation: "Wilmington" });
    expect(nextQuestion({ ...empty, ...found })).toContain("starting from");
  });

  it("fills whichever end the follow-up asked for", () => {
    const from = { ...empty, startLocation: "Chapel Hill, NC" };
    expect(nextQuestion(from)).toContain("where to");
    expect(parseDeterministic(from, "Myrtle Beach", today)).toEqual({ endLocation: "Myrtle Beach" });
    const to = { ...empty, endLocation: "Wilmington" };
    expect(parseDeterministic(to, "chapel hill", today)).toEqual({ startLocation: "Chapel Hill" });
  });

  it("never takes 'one way' as a place", () => {
    expect(parseDeterministic({ ...empty, startLocation: "Wilmington" }, "One way", today)).toEqual({
      tripType: "one_way",
    });
    expect(parseDeterministic(empty, "one way", today)).toEqual({ tripType: "one_way" });
  });

  it("asks the whole route question when neither end is known", () => {
    expect(nextQuestion(empty)).toContain("Where to?");
    expect(nextQuestion({ ...empty, tripType: "one_way" })).toContain("Where to?");
  });
});
