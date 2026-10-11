import { describe, expect, it } from "vitest";
import { isNoWish, parseBudgetDiet, parseRoute, parseTripType, placeName, refersToPhoto, tidyPlace } from "./answers";

describe("tidyPlace", () => {
  it("title-cases and formats a trailing state code", () => {
    expect(tidyPlace("chapel hill")).toBe("Chapel Hill");
    expect(tidyPlace("wilmington nc")).toBe("Wilmington, NC");
    expect(tidyPlace("Wilmington, NC")).toBe("Wilmington, NC");
    expect(tidyPlace("isle of palms sc")).toBe("Isle of Palms, SC");
  });
});

describe("parseRoute", () => {
  it("reads 'A to B' with an optional trip type", () => {
    expect(parseRoute("Chapel Hill to Wilmington")).toEqual({
      startLocation: "Chapel Hill",
      endLocation: "Wilmington",
      tripType: null,
    });
    expect(parseRoute("chapel hill → asheville nc, one way")).toEqual({
      startLocation: "Chapel Hill",
      endLocation: "Asheville, NC",
      tripType: "one_way",
    });
    expect(parseRoute("from Durham to Boone (round trip)")).toEqual({
      startLocation: "Durham",
      endLocation: "Boone",
      tripType: "round_trip",
    });
    expect(parseRoute("Asheville from Durham")).toEqual({
      startLocation: "Durham",
      endLocation: "Asheville",
      tripType: null,
    });
    expect(parseRoute("Toronto to Ottawa")).toMatchObject({ startLocation: "Toronto", endLocation: "Ottawa" });
  });

  it("returns null for anything else", () => {
    for (const text of [
      "Wilmington",
      "the beach please",
      "a to b to c",
      "I want to go to the beach with my friends",
      "I want to go to Boone from Chapel Hill",
      "we wanna go from chapel hill to boone",
    ]) {
      expect(parseRoute(text)).toBeNull();
    }
  });
});

describe("parseBudgetDiet", () => {
  it("reads budget and dietary needs in one message", () => {
    expect(parseBudgetDiet("$300, halal")).toEqual({ budgetPerPersonUsd: 300, dietaryRestrictions: ["halal"] });
    expect(parseBudgetDiet("250, none")).toEqual({ budgetPerPersonUsd: 250, dietaryRestrictions: [] });
    expect(parseBudgetDiet("250 none")).toEqual({ budgetPerPersonUsd: 250, dietaryRestrictions: [] });
    expect(parseBudgetDiet("300 vegetarian and nut allergy")).toEqual({
      budgetPerPersonUsd: 300,
      dietaryRestrictions: ["vegetarian", "nut allergy"],
    });
    expect(parseBudgetDiet("halal, $300 per person")).toEqual({
      budgetPerPersonUsd: 300,
      dietaryRestrictions: ["halal"],
    });
    expect(parseBudgetDiet("200 bucks, no restrictions")).toEqual({
      budgetPerPersonUsd: 200,
      dietaryRestrictions: [],
    });
  });

  it("returns one field when only one was given", () => {
    expect(parseBudgetDiet("300")).toEqual({ budgetPerPersonUsd: 300 });
    expect(parseBudgetDiet("$150 pp")).toEqual({ budgetPerPersonUsd: 150 });
    expect(parseBudgetDiet("halal")).toEqual({ dietaryRestrictions: ["halal"] });
    expect(parseBudgetDiet("none")).toEqual({ dietaryRestrictions: [] });
  });

  it("leaves sentences to Gemini", () => {
    expect(parseBudgetDiet("about 300 but I'm vegetarian and my friend is allergic to peanuts")).toBeNull();
    expect(parseBudgetDiet("whatever is cheapest")).toBeNull();
  });
});

describe("isNoWish", () => {
  it("spots answers that add nothing", () => {
    for (const text of ["nope", "No", "nah!", "that's it", "all good 👍", "Nope, that's it"])
      expect(isNoWish(text)).toBe(true);
    for (const text of ["beach day", "no fast food", "seafood"]) expect(isNoWish(text)).toBe(false);
  });
});

describe("parseTripType", () => {
  it("reads a trip type said on its own", () => {
    expect(parseTripType("One way")).toBe("one_way");
    expect(parseTripType("just one-way!")).toBe("one_way");
    expect(parseTripType("round trip")).toBe("round_trip");
    expect(parseTripType("Wilmington one way")).toBeNull();
  });
});

describe("placeName", () => {
  it("accepts a bare place and tidies it", () => {
    expect(placeName("Myrtle Beach")).toBe("Myrtle Beach");
    expect(placeName("asheville nc")).toBe("Asheville, NC");
    expect(placeName("Wilmington ")).toBe("Wilmington");
  });

  it("rejects trip types, vibes, small talk and sentences", () => {
    for (const text of [
      "One way",
      "round trip",
      "the beach",
      "mountains",
      "idk",
      "yes",
      "somewhere warm",
      "I want Boone",
    ])
      expect(placeName(text)).toBeNull();
  });
});

describe("refersToPhoto", () => {
  it("spots captions that point at a photo", () => {
    for (const text of ["include stops similar to this", "this place!", "something like these", "that one", "this 👀"])
      expect(refersToPhoto(text)).toBe(true);
    for (const text of ["beach day", "nope", "a waterfall hike", "like this trip a lot", "seafood"])
      expect(refersToPhoto(text)).toBe(false);
  });
});
