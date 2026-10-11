import { describe, expect, it } from "vitest";
import { addDays, daysBetween, formatDuration, toZonedIso, zonedToDate } from "./time";

describe("time", () => {
  it("round-trips local time in a zone, across DST", () => {
    const summer = zonedToDate("2026-10-17", "09:00", "America/New_York");
    expect(summer.toISOString()).toBe("2026-10-17T13:00:00.000Z");
    expect(toZonedIso(summer, "America/New_York")).toBe("2026-10-17T09:00:00-04:00");
    const winter = zonedToDate("2026-12-05", "09:30", "America/New_York");
    expect(toZonedIso(winter, "America/New_York")).toBe("2026-12-05T09:30:00-05:00");
    expect(toZonedIso(zonedToDate("2026-10-17", "09:00", "UTC"), "UTC")).toBe("2026-10-17T09:00:00+00:00");
  });

  it("does date arithmetic", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(daysBetween("2026-10-17", "2026-10-19")).toBe(2);
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3h 05m");
  });
});
