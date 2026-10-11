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
  "place_canonicalization",
  "image_interpretation",
  "added_stop",
]);
export type LlmTask = z.infer<typeof LlmTask>;

/** How hard the model may think. Lower = faster; extraction and mapping don't need deliberation. */
export type LlmEffort = "minimal" | "low" | "medium" | "high";

/** Defaults per task, tuned for chat latency (a live demo can't wait ~85 s for a draft). */
export const DEFAULT_EFFORT: Record<LlmTask, LlmEffort> = {
  predefined_extraction: "minimal",
  optional_extraction: "minimal",
  vote_mapping: "minimal",
  place_canonicalization: "minimal",
  conflict_analysis: "low",
  itinerary_draft: "low",
  feedback_assessment: "low",
  live_update: "low",
  replacement_stop: "low",
  image_interpretation: "low", // reads a photo and places it with Google Search
  added_stop: "low",
};

export interface LlmRequest<T> {
  task: LlmTask;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Ground the answer with Google Search (place lookups). */
  webSearch?: boolean;
  /** Overrides DEFAULT_EFFORT[task]. */
  effort?: LlmEffort;
  /** Images the member sent, sent to Gemini alongside the prompt (never stored). */
  images?: LlmImage[];
}

export interface LlmImage {
  mimeType: string;
  base64: string;
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
