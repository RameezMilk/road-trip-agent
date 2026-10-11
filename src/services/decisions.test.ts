import { describe, expect, it } from "vitest";
import { OpenAiDecider } from "./decisions";

const choices = [
  { value: "opt_a", description: "1. Chapel Hill → Wilmington" },
  { value: "opt_b", description: "2. Chapel Hill → Asheville" },
  { value: "none", description: "Doesn't pick an option" },
];
const question = { name: "vote", instructions: "Which option does the reply choose?", evidence: "Asheville!", choices };

describe("OpenAiDecider", () => {
  it("returns the chosen option and sends one constrained question with a short timeout", async () => {
    const calls: unknown[] = [];
    const decider = new OpenAiDecider("k", "gpt-6-luna", undefined, 2500, async (body, options) => {
      calls.push({ body, options });
      return { answers: [{ type: "choice", name: "vote", choice: "opt_b", confidence: 0.93, probabilities: [] }] };
    });
    expect(await decider.choose(question)).toEqual({ value: "opt_b", confidence: 0.93 });
    expect(calls).toEqual([
      {
        body: {
          model: "gpt-6-luna",
          input: "Asheville!",
          questions: [{ type: "choice", name: "vote", instructions: question.instructions, choices }],
        },
        options: { timeout: 2500, maxRetries: 0 },
      },
    ]);
  });

  it("returns null on refusal, errors, malformed output or a value it wasn't offered", async () => {
    const answers = [
      { answers: [{ type: "refusal", name: "vote" }] },
      { answers: [{ type: "choice", name: "vote", choice: "opt_zzz", confidence: 0.9 }] },
      { answers: [{ type: "choice", name: "vote", choice: "opt_a", confidence: 7 }] },
      { nope: true },
    ];
    for (const answer of answers) {
      const decider = new OpenAiDecider("k", "m", undefined, 10, async () => answer);
      expect(await decider.choose(question)).toBeNull();
    }
    const failing = new OpenAiDecider("k", "m", undefined, 10, async () => {
      throw new Error("403 not enabled");
    });
    expect(await failing.choose(question)).toBeNull();
    expect(await failing.predicate({ name: "p", instructions: "i", evidence: "e" })).toBeNull();
  });

  it("reads predicate probabilities", async () => {
    const decider = new OpenAiDecider("k", "m", undefined, 10, async () => ({
      answers: [{ type: "predicate", name: "compatible", probability: 0.81 }],
    }));
    expect(await decider.predicate({ name: "compatible", instructions: "i", evidence: "e" })).toBe(0.81);
  });
});
