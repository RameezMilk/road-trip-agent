import type { MarkerKind } from "@rta/contracts";
import { type Config, requireConfig } from "../config";
import { NotBuiltError } from "../errors";

/** A row from the curated, source-backed public corridor corpus. Current facts are re-resolved via Places. */
export interface CorpusMatch {
  sourceId: string;
  title: string;
  text: string;
  category: MarkerKind;
  sourceUrl: string;
}

/** Cortex Search REST query over the corpus. Snowflake never holds votes or private trip data. */
export interface CorridorKnowledge {
  search(input: { query: string; categories?: MarkerKind[]; limit?: number }): Promise<CorpusMatch[]>;
}

export function createSnowflake(config: Config): CorridorKnowledge {
  requireConfig(config, "Snowflake", [
    "SNOWFLAKE_ACCOUNT_URL",
    "SNOWFLAKE_PAT",
    "SNOWFLAKE_DATABASE",
    "SNOWFLAKE_SCHEMA",
    "SNOWFLAKE_CORTEX_SEARCH_SERVICE",
  ]);
  throw new NotBuiltError("Snowflake Cortex Search");
}
