import { describe, expect, it } from "vitest";
import { monthOf, parseDateRange } from "./dates";

const TODAY = "2026-10-11";
const range = (startDate: string, endDate: string) => ({ startDate, endDate });

describe("monthOf", () => {
  it("reads full names, abbreviations and misspellings", () => {
    expect(monthOf("October")).toBe(10);
    expect(monthOf("oct")).toBe(10);
    expect(monthOf("Oct.")).toBe(10);
    expect(monthOf("Octobr")).toBe(10);
    expect(monthOf("ocotber")).toBe(10);
    expect(monthOf("sept")).toBe(9);
    expect(monthOf("Novmber")).toBe(11);
    expect(monthOf("dec")).toBe(12);
  });

  it("rejects words that aren't months", () => {
    for (const word of ["to", "the", "and", "weekend", "next", "day", "trip", "may be"]) {
      expect(monthOf(word)).toBeNull();
    }
  });
});

describe("parseDateRange", () => {
  it("handles the common one-message answers", () => {
    expect(parseDateRange("Oct 18 to Oct 25", TODAY)).toEqual(range("2026-10-18", "2026-10-25"));
    expect(parseDateRange("oct 18-19", TODAY)).toEqual(range("2026-10-18", "2026-10-19"));
    expect(parseDateRange("Octobr 18 to 19", TODAY)).toEqual(range("2026-10-18", "2026-10-19"));
    expect(parseDateRange("October 18th – 20th", TODAY)).toEqual(range("2026-10-18", "2026-10-20"));
    expect(parseDateRange("18-20 oct", TODAY)).toEqual(range("2026-10-18", "2026-10-20"));
    expect(parseDateRange("10/18-10/20", TODAY)).toEqual(range("2026-10-18", "2026-10-20"));
    expect(parseDateRange("from oct 30 to nov 2", TODAY)).toEqual(range("2026-10-30", "2026-11-02"));
    expect(parseDateRange("Oct 18, 2026 - Oct 20, 2026", TODAY)).toEqual(range("2026-10-18", "2026-10-20"));
  });

  it("treats a single day as a day trip", () => {
    expect(parseDateRange("Oct 18", TODAY)).toEqual(range("2026-10-18", "2026-10-18"));
  });

  it("rolls past dates into next year, and year-end ranges across it", () => {
    expect(parseDateRange("jan 3-5", TODAY)).toEqual(range("2027-01-03", "2027-01-05"));
    expect(parseDateRange("dec 30 to jan 2", TODAY)).toEqual(range("2026-12-30", "2027-01-02"));
  });

  it("returns null for what Gemini should handle", () => {
    for (const text of ["this weekend", "next fri to sun", "whenever", "Oct 32", "2 days starting oct 18", ""]) {
      expect(parseDateRange(text, TODAY)).toBeNull();
    }
  });
});
