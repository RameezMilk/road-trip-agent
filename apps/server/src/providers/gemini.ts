import type { GroundedPlace, StructuredPlan, TripIntent } from "@rta/contracts";
import { type Config, requireConfig } from "../config";
import { NotBuiltError } from "../errors";

/** Inputs Gemini may see. Raw private submissions never go here — only permitted group summaries. */
export interface ExtractionInput {
  text: string;
  images: { mimeType: string; data: Buffer }[];
  /** iMessage .caf voice notes must be transcoded (e.g. to m4a) before reaching Gemini. */
  audio: { mimeType: string; data: Buffer }[];
}

/** Schema-bound extraction; output is validated against the contract and gets one bounded repair attempt. */
export interface IntentExtractor {
  extractTripIntent(input: ExtractionInput): Promise<TripIntent>;
}

/** May rank/select only the candidate IDs it is given; the server rejects anything else. */
export interface PlanSelector {
  selectPlan(input: {
    tripId: string;
    planVersion: number;
    candidates: GroundedPlace[];
    preferenceSummary: string;
  }): Promise<StructuredPlan>;
}

export function createGemini(config: Config): IntentExtractor & PlanSelector {
  requireConfig(config, "Gemini", ["GEMINI_API_KEY"]);
  throw new NotBuiltError("Gemini");
}
