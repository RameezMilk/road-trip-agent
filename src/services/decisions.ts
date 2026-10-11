import OpenAI from "openai";
import type { DecisionCreateParams } from "openai/resources/decisions";
import { z } from "zod";

type Log = (event: string, data?: Record<string, unknown>) => void;

export interface DecisionChoice {
  value: string;
  description: string;
}

export interface ChooseQuestion {
  /** Short id for logs. */
  name: string;
  instructions: string;
  /** The text being judged (a reply, a list of wishes, a place). */
  evidence: string;
  choices: DecisionChoice[];
}

export interface PredicateQuestion {
  name: string;
  instructions: string;
  evidence: string;
}

/**
 * Fast constrained decisions: pick one of N options, or the probability that a statement holds. It never
 * extracts text. `null` means "no decision available" (no key, refusal, error, timeout); every caller then
 * falls back to its Gemini path, so a missing Decider slows things down but never changes behaviour.
 */
export interface Decider {
  choose(question: ChooseQuestion): Promise<{ value: string; confidence: number } | null>;
  predicate(question: PredicateQuestion): Promise<number | null>;
}

export const noDecider: Decider = {
  choose: async () => null,
  predicate: async () => null,
};

type CreateFn = (body: DecisionCreateParams, options: { timeout: number; maxRetries: number }) => Promise<unknown>;

// The response is untrusted input like any model output.
const Answers = z.object({ answers: z.array(z.unknown()) });
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.union([z.string(), z.boolean()]),
  confidence: z.number().min(0).max(1),
});
const PredicateAnswer = z.object({ type: z.literal("predicate"), probability: z.number().min(0).max(1) });

/** OpenAI Decisions API (`POST /v1/decisions`, public beta). About 10× faster than a generative call. */
export class OpenAiDecider implements Decider {
  private readonly create: CreateFn;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly log: Log = () => {},
    private readonly timeoutMs = 2500,
    create?: CreateFn,
  ) {
    if (create) this.create = create;
    else {
      const client = new OpenAI({ apiKey });
      this.create = (body, options) => client.decisions.create(body, options);
    }
  }

  async choose(q: ChooseQuestion): Promise<{ value: string; confidence: number } | null> {
    const answer = await this.ask(q.name, q.evidence, {
      type: "choice",
      name: q.name,
      instructions: q.instructions,
      choices: q.choices.map((c) => ({ value: c.value, description: c.description })),
    });
    const parsed = ChoiceAnswer.safeParse(answer);
    if (!parsed.success) return null;
    const value = String(parsed.data.choice);
    if (!q.choices.some((c) => c.value === value)) {
      this.log("decision_invalid", { name: q.name });
      return null;
    }
    return { value, confidence: parsed.data.confidence };
  }

  async predicate(q: PredicateQuestion): Promise<number | null> {
    const answer = await this.ask(q.name, q.evidence, {
      type: "predicate",
      name: q.name,
      instructions: q.instructions,
    });
    const parsed = PredicateAnswer.safeParse(answer);
    return parsed.success ? parsed.data.probability : null;
  }

  private async ask(
    name: string,
    evidence: string,
    question: DecisionCreateParams["questions"][number],
  ): Promise<unknown> {
    const started = Date.now();
    try {
      const raw = await this.create(
        { model: this.model, input: evidence, questions: [question] },
        { timeout: this.timeoutMs, maxRetries: 0 },
      );
      const answer = Answers.parse(raw).answers[0];
      const type = (answer as { type?: unknown } | undefined)?.type;
      this.log(type === "refusal" ? "decision_refused" : "decision_ok", { name, ms: Date.now() - started });
      return answer;
    } catch (error) {
      this.log("decision_failed", { name, ms: Date.now() - started, error: String(error).slice(0, 200) });
      return null;
    }
  }
}
