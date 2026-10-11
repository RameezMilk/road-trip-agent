import { describe, expect, it } from "vitest";
import { decodeEntitiesDeep } from "./gemini";

describe("decodeEntitiesDeep", () => {
  it("undoes HTML escaping in every string of a Gemini answer", () => {
    expect(
      decodeEntitiesDeep({
        title: "Blue Ridge Waterfall &amp; Halal Road Trip",
        days: [{ stops: [{ name: "Joe&#39;s Diner", note: "&quot;best&quot; &lt;3 &#x2764;" }] }],
        n: 3,
      }),
    ).toEqual({
      title: "Blue Ridge Waterfall & Halal Road Trip",
      days: [{ stops: [{ name: "Joe's Diner", note: '"best" <3 ❤' }] }],
      n: 3,
    });
  });
});
