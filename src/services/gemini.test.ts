import { describe, expect, it, vi } from "vitest";
import { ImageInterpretation } from "../schemas";
import { decodeEntitiesDeep, GeminiLlm } from "./gemini";

/** A GeminiLlm whose Interactions client is replaced by `create`. */
function stubbed(create: ReturnType<typeof vi.fn>): GeminiLlm {
  const llm = new GeminiLlm("test-key", "gemini-test");
  (llm as unknown as { client: unknown }).client = { interactions: { create } };
  return llm;
}

const ANSWER = { kind: "scene", placeName: null, city: null, description: "Waterfall", category: "activities" };

describe("GeminiLlm image input", () => {
  it("sends plain text without images, and text plus image parts with them (also on the repair retry)", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ output_text: JSON.stringify(ANSWER) })
      .mockResolvedValueOnce({ output_text: "not json" })
      .mockResolvedValueOnce({ output_text: JSON.stringify(ANSWER) });
    const llm = stubbed(create);
    const base = { task: "image_interpretation" as const, system: "s", prompt: "p", schema: ImageInterpretation };

    await llm.generate(base);
    expect(create.mock.calls[0]?.[0].input).toBe("p");

    const result = await llm.generate({ ...base, images: [{ mimeType: "image/heic", base64: "AAAA" }] });
    expect(result.description).toBe("Waterfall");
    for (const call of create.mock.calls.slice(1)) {
      expect(call[0].input).toEqual([
        { type: "text", text: expect.stringContaining("p") },
        { type: "image", data: "AAAA", mime_type: "image/heic" },
      ]);
    }
    expect(create).toHaveBeenCalledTimes(3);
  });
});

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
