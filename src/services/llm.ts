import { z } from "zod";

/** Every kind of Gemini call the agent makes (used for logging and for scripting the fake in tests). */
export const LlmTask = z.enum([
  "predefined_extraction",
  "optional_extraction",
  "conflict_analysis",
  "vote_mapping",
  "itinerary_draft",
  "feedback_assessment",
  "live_update",
  "replacement_stop",
]);
export type LlmTask = z.infer<typeof LlmTask>;

export interface LlmRequest<T> {
  task: LlmTask;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Ground the answer with Google Search (place lookups). */
  webSearch?: boolean;
}

/** Structured generation: the result has already passed `schema` (LLM output is untrusted). */
export interface Llm {
  generate<T>(request: LlmRequest<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(
    readonly task: LlmTask,
    message: string,
  ) {
    super(`${task}: ${message}`);
    this.name = "LlmError";
  }
}
