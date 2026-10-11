import { describe, expect, it } from "vitest";
import type { Itinerary, ItineraryStop, RouteLeg } from "../schemas";
import { alignMeals, breakPoints, scheduleIssues } from "./humane";

let n = 0;
const at = (day: number, hhmm: string) => `2026-10-${16 + day}T${hhmm}:00-04:00`;
function stop(
  day: number,
  kind: ItineraryStop["kind"],
  name: string,
  arrive: string | null,
  depart: string | null,
  dwellMinutes: number,
): ItineraryStop {
  return {
    id: `stop_${++n}`,
    day,
    kind,
    name,
    address: null,
    latLng: { lat: 35, lng: -79 },
    geocodeSource: "nominatim",
    arriveAt: arrive ? at(day, arrive) : null,
    departAt: depart ? at(day, depart) : null,
    dwellMinutes,
    note: null,
    sustainable: false,
    sourceUrl: null,
    webEstimateCostPerPersonUsd: null,
  };
}
const leg = (minutes: number, points = 11): RouteLeg => ({
  fromStopId: "stop_a",
  toStopId: "stop_b",
  distanceMeters: minutes * 1500,
  durationSeconds: minutes * 60,
  source: "osrm",
  geometry: Array.from({ length: points }, (_, i) => [35, -79 + i / 10] as [number, number]),
});
const trip = (stops: ItineraryStop[], minutes: number[]) =>
  ({ stops, legs: minutes.map((m) => leg(m)), timeZone: "America/New_York" }) as unknown as Itinerary;

describe("scheduleIssues", () => {
  it("passes a humane day", () => {
    const stops = [
      stop(1, "origin", "Home", null, "09:00", 0),
      stop(1, "rest_stop", "Rest Area", "10:45", "11:00", 15),
      stop(1, "restaurant", "Lunch", "12:30", "13:15", 45),
      stop(1, "destination", "Beach", "14:30", "17:30", 180),
      stop(1, "restaurant", "Dinner", "18:00", "19:15", 75),
      stop(1, "lodging", "Inn", "19:30", null, 0),
    ];
    expect(scheduleIssues(trip(stops, [105, 90, 75, 30, 15]))).toEqual([]);
  });

  it("flags meals at odd hours, meals back to back, missing lunch, long drives, and night driving", () => {
    const issues = scheduleIssues(
      trip(
        [
          stop(1, "origin", "Home", null, "08:00", 0),
          stop(1, "restaurant", "Brunch", "10:45", "11:30", 45),
          stop(1, "restaurant", "Second lunch", "12:00", "12:45", 45),
          stop(1, "destination", "Beach", "16:00", "22:00", 360),
          stop(1, "lodging", "Inn", "23:30", null, 0),
        ],
        [165, 30, 195, 90],
      ),
    );
    expect(issues.join("\n")).toMatch(/Brunch is a meal at 10:45 AM/);
    expect(issues.join("\n")).toMatch(/Brunch .* and Second lunch .* back to back/);
    expect(issues.join("\n")).toMatch(/2h 45m of driving from Home to Brunch/);
    expect(issues.join("\n")).toMatch(/3h 15m of driving from Second lunch to Beach/);
    expect(issues.join("\n")).toMatch(/arriving at Inn at 11:30 PM/);

    const noLunch = scheduleIssues(
      trip(
        [
          stop(1, "origin", "Home", null, "09:00", 0),
          stop(1, "attraction", "Museum", "10:00", "14:00", 240),
          stop(1, "destination", "Beach", "15:00", null, 0),
        ],
        [60, 60],
      ),
    );
    expect(noLunch).toEqual(["Day 1: no lunch stop (11:30 AM–1:30 PM) — around then the group is at or near Museum."]);
  });

  it("exempts quick coffee or ice-cream stops from mealtimes", () => {
    const stops = [
      stop(1, "origin", "Home", null, "09:00", 0),
      stop(1, "restaurant", "Coffee", "10:50", "11:05", 15),
      stop(1, "destination", "Town", "12:00", null, 0),
    ];
    expect(scheduleIssues(trip(stops, [110, 55]))).toEqual([]);
  });
});

describe("alignMeals", () => {
  it("lets an early dinner wait at the previous activity, and shifts what follows", () => {
    const stops = [
      stop(1, "origin", "Home", null, "09:00", 0),
      stop(1, "destination", "Beach", "14:00", "16:00", 120),
      stop(1, "restaurant", "Dinner", "16:15", "17:30", 75),
      stop(1, "lodging", "Inn", "17:45", null, 0),
    ];
    const aligned = alignMeals(stops, [leg(300), leg(15), leg(15)], "America/New_York");
    expect(aligned[1]?.dwellMinutes).toBe(210);
    expect(aligned[2]?.arriveAt).toBe(at(1, "17:45"));
    expect(aligned[3]?.arriveAt).toBe(at(1, "19:15"));
  });

  it("doesn't make anyone wait more than 3 hours, or at a gas station", () => {
    const stops = [
      stop(1, "origin", "Home", null, "09:00", 0),
      stop(1, "gas", "Gas", "11:00", "11:10", 10),
      stop(1, "restaurant", "Early lunch", "10:00", "10:45", 45),
    ];
    expect(alignMeals(stops, [leg(120), leg(-70)], "America/New_York")[2]?.arriveAt).toBe(at(1, "10:00"));
  });
});

describe("breakPoints", () => {
  it("splits a long leg evenly with stretch breaks on the route", () => {
    const stops = [stop(1, "origin", "Home", null, "09:00", 0), stop(1, "destination", "Beach", "13:00", null, 0)];
    // 4 h → one break halfway; 5 h → two, at 1 h 40 m and 3 h 20 m (no piece over 2 hours).
    const four = breakPoints(stops, [leg(240)]);
    expect(four.map((p) => [p.afterIndex, p.order])).toEqual([[0, 0]]);
    expect(four[0]?.latLng.lng).toBeCloseTo(-79 + 0.5, 5);
    const five = breakPoints(stops, [leg(300)]);
    expect(five.map((p) => p.latLng.lng)).toEqual([-79 + 0.3, -79 + 0.7].map((x) => expect.closeTo(x, 5)));
  });

  it("adds nothing when real stops already break the drive", () => {
    const stops = [
      stop(1, "origin", "Home", null, "09:00", 0),
      stop(1, "restaurant", "Lunch", "11:00", "11:45", 45),
      stop(1, "destination", "Beach", "13:30", null, 0),
    ];
    expect(breakPoints(stops, [leg(120), leg(105)])).toEqual([]);
  });
});
