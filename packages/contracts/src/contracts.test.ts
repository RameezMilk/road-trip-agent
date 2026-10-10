import { describe, expect, it } from "vitest";
import { FeasibilityResult, IsoDateTime, LatLng, TripIntent, Vote } from "./index";

const emptyIntent = {
  originQuery: "Chapel Hill, NC",
  destinationQuery: "Asheville, NC",
  date: null,
  timeZone: "America/New_York",
  departAt: null,
  latestArrivalAt: null,
  maxExtraDriveMinutes: null,
  stopTimeAllowanceMinutes: null,
  mealSpend: null,
  desiredKinds: ["scenic"],
  constraints: [],
  vehicle: null,
  missingFields: ["date", "departAt"],
};

describe("contracts", () => {
  it("accepts a partial TripIntent with explicit nulls", () => {
    expect(TripIntent.safeParse(emptyIntent).success).toBe(true);
  });

  it("rejects unknown fields and omitted fields", () => {
    expect(TripIntent.safeParse({ ...emptyIntent, budget: 50 }).success).toBe(false);
    const { vehicle: _omitted, ...withoutVehicle } = emptyIntent;
    expect(TripIntent.safeParse(withoutVehicle).success).toBe(false);
  });

  it("rejects unknown time zones", () => {
    expect(TripIntent.safeParse({ ...emptyIntent, timeZone: "Mars/Olympus" }).success).toBe(false);
  });

  it("requires timestamps to carry an offset", () => {
    expect(IsoDateTime.safeParse("2026-10-11T09:00:00-04:00").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-10-11T13:00:00Z").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-10-11T09:00:00").success).toBe(false);
  });

  it("rejects out-of-range coordinates", () => {
    expect(LatLng.safeParse({ lat: 35.91, lng: -79.05 }).success).toBe(true);
    expect(LatLng.safeParse({ lat: 91, lng: 0 }).success).toBe(false);
  });

  it("rejects wrongly prefixed IDs", () => {
    const vote = {
      eventId: "evt_abc123",
      tripId: "trip_abc123",
      planVersion: 1,
      participantId: "part_abc123",
      candidateId: "cand_abc123",
      state: "like",
      castAt: "2026-10-11T09:00:00-04:00",
      source: "chat_command",
    };
    expect(Vote.safeParse(vote).success).toBe(true);
    expect(Vote.safeParse({ ...vote, candidateId: "trip_abc123" }).success).toBe(false);
  });

  it("refuses a 'feasible' result that contains a failed check", () => {
    const result = {
      tripId: "trip_abc123",
      planVersion: 2,
      checks: [{ name: "arrival_deadline", status: "failed", detail: "Arrives 18 min late", candidateId: null }],
      totalDriveSeconds: 14_400,
      totalStopSeconds: 3_600,
      departAt: "2026-10-11T08:00:00-04:00",
      projectedArrivalAt: "2026-10-11T13:18:00-04:00",
      feasible: true,
    };
    expect(FeasibilityResult.safeParse(result).success).toBe(false);
    expect(FeasibilityResult.safeParse({ ...result, feasible: false }).success).toBe(true);
  });
});
