import { describe, expect, it } from "vitest";
import { CODE_TTL_MS, ProbeStore, senderTag, spaceHash } from "./probe-store";

describe("ProbeStore", () => {
  it("consumes a code exactly once", () => {
    const store = new ProbeStore();
    const { code } = store.mint({ cardSpaceHash: "abc", userAgent: "ua" });
    expect(store.consume(code.toLowerCase())).toMatchObject({ ok: true });
    expect(store.consume(code)).toEqual({ ok: false, reason: "used" });
  });

  it("rejects expired, unknown and malformed codes", () => {
    let now = 0;
    const store = new ProbeStore(() => now);
    const { code } = store.mint({ cardSpaceHash: null, userAgent: "ua" });
    now = CODE_TTL_MS + 1;
    expect(store.consume(code)).toEqual({ ok: false, reason: "expired" });
    expect(store.consume("ZZZZZZ")).toEqual({ ok: false, reason: "unknown" });
    expect(store.consume("12")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("tags", () => {
  it("never contain the full handle and are stable", () => {
    const tag = senderTag("+19195551234");
    expect(tag).not.toContain("+1919555");
    expect(tag.endsWith("1234")).toBe(true);
    expect(senderTag("+19195551234")).toBe(tag);
    expect(senderTag(undefined)).toBe("unknown");
    expect(spaceHash("any;-;+15551111111")).toHaveLength(10);
  });
});
