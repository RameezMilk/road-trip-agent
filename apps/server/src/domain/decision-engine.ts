import type { CostEnergyEstimate, StructuredPlan } from "@rta/contracts";
import type { Config } from "../config";

/**
 * Optional post-Gemini stage behind ENABLE_DECISIONS_API (default false). No vendor is selected — do not
 * fabricate an SDK or substitute another LLM. Deterministic validation runs regardless of this stage.
 */
export interface ValidatedDecisionInput {
  plan: StructuredPlan;
  eligibleCandidateIds: string[];
  /** Permitted aggregate preference summaries only — never raw private conversations. */
  preferenceSummaries: string[];
  costEstimates: CostEnergyEstimate[];
}

export type DecisionResult =
  | { status: "disabled" }
  | { status: "unconfigured" }
  | { status: "ran"; rankedCandidateIds: string[]; latencyMs: number }
  /** Timeout, refusal or invalid IDs: callers fall back to local scoring and surface degraded status. */
  | { status: "failed"; reason: string; latencyMs: number };

export interface DecisionEngine {
  evaluate(input: ValidatedDecisionInput): Promise<DecisionResult>;
}

export function createDecisionEngine(config: Config): DecisionEngine {
  if (!config.ENABLE_DECISIONS_API) return { evaluate: async () => ({ status: "disabled" }) };
  return { evaluate: async () => ({ status: "unconfigured" }) };
}
