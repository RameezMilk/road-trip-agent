import { describe, expect, it } from "vitest";
import type { Poll, PollVote } from "../schemas";
import { diffItineraries, formatDiff } from "./diff";
import {
  type CompleteRequirements,
  draftKey,
  missingFields,
  predefinedPolls,
  reconcilePredefined,
  unifyPlaces,
} from "./reconcile";
import { buildItinerary, currentStopIndex, finalizeItinerary, shiftSchedule } from "./schedule";
import { tally, tiebreak } from "./tally";
import { LEGS, PLACED, RESOLVED } from "./test-fixtures";

const base: CompleteRequirements = {
  startLocation: "Chapel Hill, NC",
  endLocation: "Asheville, NC",
  startDate: "2026-10-17",
  endDate: "2026-10-18",
  tripType: "one_way",
  budgetPerPersonUsd: 200,
  dietaryRestrictions: [],
};

describe("reconcilePredefined", () => {
  it("agrees when values match loosely, takes the lowest budget and unions dietary restrictions", () => {
    const rec = reconcilePredefined([
      { ...base, dietaryRestrictions: ["Halal"] },
      {
        ...base,
        startLocation: "chapel hill, north carolina",
        budgetPerPersonUsd: 120,
        dietaryRestrictions: ["halal", "vegetarian", "none"],
      },
    ]);
    expect(rec.route.kind).toBe("agreed");
    expect(rec.dates.kind).toBe("agreed");
    expect(rec.budgetPerPersonUsd).toBe(120);
    expect(rec.dietaryRestrictions).toEqual(["Halal", "vegetarian"]);
    expect(predefinedPolls("trip_x", rec)).toEqual([]);
  });

  it("creates route and dates polls with an abstain option when members differ", () => {
    const rec = reconcilePredefined([
      base,
      { ...base, endLocation: "Boone, NC", startDate: "2026-10-24", endDate: "2026-10-25" },
    ]);
    const polls = predefinedPolls("trip_x", rec);
    expect(polls.map((p) => p.kind)).toEqual(["route", "dates"]);
    expect(polls[0]?.options.map((o) => o.label)).toEqual([
      "Chapel Hill, NC → Asheville, NC (one way)",
      "Chapel Hill, NC → Boone, NC (one way)",
      "Either works for me",
    ]);
    expect(polls[1]?.options[0]?.label).toBe("Sat, Oct 17 – Sun, Oct 18");
  });

  it("lists missing fields in ask order", () => {
    expect(missingFields({ ...base, startDate: null, tripType: null })).toEqual(["startDate", "tripType"]);
  });
});

describe("unifyPlaces / draftKey", () => {
  it("treats a name without a state as the one stated variant", () => {
    const same = unifyPlaces(["Wilmington", "Wilmington, NC", "Chapel Hill"]);
    expect(same("Wilmington")).toBe("Wilmington, NC");
    expect(same("Chapel Hill")).toBe("Chapel Hill");
    const ambiguous = unifyPlaces(["Wilmington", "Wilmington, NC", "Wilmington, DE"]);
    expect(ambiguous("Wilmington")).toBe("Wilmington");
  });

  it("ignores decisions and ordering when matching draft requests", () => {
    const a = { ...RESOLVED, dietaryRestrictions: ["halal", "Vegan"], decisions: [] };
    const b = {
      ...RESOLVED,
      dietaryRestrictions: ["vegan", "halal"],
      decisions: [{ pollId: "poll_x", question: "Where?", winningLabel: "A", votes: 2, voters: 2 }],
    };
    expect(draftKey(a)).toBe(draftKey(b as typeof a));
    expect(draftKey(a)).not.toBe(draftKey({ ...a, endDate: "2099-01-01" }));
  });
});

describe("tally", () => {
  const poll: Poll = {
    id: "poll_aaaaaaaaaaaa",
    tripId: "trip_aaaaaaaaaaaa",
    kind: "optional",
    question: "q",
    status: "open",
    round: 1,
    sequence: 0,
    winningOptionId: null,
    createdAt: new Date(),
    closedAt: null,
    options: [
      { id: "opt_a", label: "A", value: { kind: "optional", requirementIds: ["req_1"], resolution: "a" } },
      { id: "opt_b", label: "B", value: { kind: "optional", requirementIds: ["req_1", "req_2"], resolution: "b" } },
      { id: "opt_x", label: "Either", value: { kind: "abstain" } },
    ],
  };
  const vote = (memberId: string, optionId: string): PollVote => ({
    pollId: poll.id,
    memberId,
    optionId,
    via: "number",
    rawText: null,
    castAt: new Date(),
  });

  it("picks the most-voted real option, ignoring abstains", () => {
    expect(tally(poll, [vote("m1", "opt_a"), vote("m2", "opt_x"), vote("m3", "opt_a")])).toMatchObject({
      kind: "winner",
      optionId: "opt_a",
      votes: 2,
      voters: 3,
    });
  });

  it("reports ties, and the first option wins when everyone abstains", () => {
    expect(tally(poll, [vote("m1", "opt_a"), vote("m2", "opt_b")])).toMatchObject({
      kind: "tie",
      optionIds: ["opt_a", "opt_b"],
    });
    expect(tally(poll, [vote("m1", "opt_x"), vote("m2", "opt_x")])).toMatchObject({
      kind: "winner",
      optionId: "opt_a",
    });
  });

  it("breaks optional ties by supporting requirements", () => {
    expect(tiebreak(poll, ["opt_a", "opt_b"])).toBe("opt_b");
  });
});

describe("schedule", () => {
  const itinerary = buildItinerary({
    tripId: "trip_aaaaaaaaaaaa",
    version: 1,
    title: "Fall break",
    timeZone: "America/New_York",
    resolved: RESOLVED,
    stops: PLACED,
    legs: LEGS,
    dayDepartTimes: new Map([
      [1, "09:00"],
      [2, "08:30"],
    ]),
    memberCount: 3,
    vehicleMpg: 30,
    gasPriceUsdPerGallon: 3,
    rationale: null,
    droppedStops: [],
    now: new Date("2026-10-10T12:00:00Z"),
  });

  it("chains legs and dwell times and starts each day at its departure time", () => {
    const times = itinerary.stops.map((s) => [s.arriveAt, s.departAt]);
    expect(times).toEqual([
      [null, "2026-10-17T09:00:00-04:00"],
      ["2026-10-17T10:00:00-04:00", "2026-10-17T11:00:00-04:00"],
      ["2026-10-17T12:00:00-04:00", "2026-10-18T08:30:00-04:00"],
      ["2026-10-18T09:30:00-04:00", "2026-10-18T10:15:00-04:00"],
      ["2026-10-18T11:15:00-04:00", null],
    ]);
    expect(itinerary.totals.driveSeconds).toBe(4 * 3600);
    expect(itinerary.totals.webEstimateStopCostPerPersonUsd).toBe(20);
  });

  it("computes carpool fuel and CO₂ savings deterministically", () => {
    const s = itinerary.sustainability;
    expect(s.soloFuelGallons).toBeCloseTo(s.fuelGallons * 3, 1);
    expect(s.co2KgPerPersonSolo).toBeCloseTo(s.co2KgPerPerson * 3, 1);
    expect(s.greenStops).toBe(1);
    expect(s.totalStops).toBe(3);
  });

  it("shifts the rest of the day after a delay but leaves later days alone", () => {
    const shifted = shiftSchedule(itinerary, "stop_lunch0000000001", 30);
    expect(shifted[1]?.departAt).toBe("2026-10-17T11:30:00-04:00");
    expect(shifted[2]?.arriveAt).toBe("2026-10-17T12:30:00-04:00");
    expect(shifted[2]?.departAt).toBe("2026-10-18T08:30:00-04:00");
    expect(shifted[3]).toEqual(itinerary.stops[3]);
  });

  it("finds the current stop and diffs versions", () => {
    expect(currentStopIndex(itinerary, new Date("2026-10-17T14:30:00Z"))).toBe(1);
    const next = finalizeItinerary({
      ...itinerary,
      resolved: RESOLVED,
      version: 2,
      stops: shiftSchedule(itinerary, "stop_lunch0000000001", 30).filter((s) => s.kind !== "scenic"),
      memberCount: 3,
      vehicleMpg: 30,
      gasPriceUsdPerGallon: 3,
    });
    const diff = diffItineraries(itinerary, next);
    expect(diff.removed).toEqual(["Blue Ridge Overlook"]);
    expect(diff.retimed).toBe(2);
    expect(formatDiff(diff)).toContain("Removed: Blue Ridge Overlook");
  });
});
