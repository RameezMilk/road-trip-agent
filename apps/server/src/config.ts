import { z } from "zod";
import { NotConfiguredError } from "./errors";

// Empty strings from a copied .env.example mean "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: optional(z.url().transform((u) => u.replace(/\/+$/, ""))),

  SPECTRUM_PROJECT_ID: optional(z.string()),
  SPECTRUM_PROJECT_SECRET: optional(z.string()),

  GEMINI_API_KEY: optional(z.string()),
  GOOGLE_MAPS_SERVER_KEY: optional(z.string()),
  GOOGLE_MAPS_BROWSER_KEY: optional(z.string()),
  GOOGLE_MAP_ID: optional(z.string()),
  DATABASE_URL: optional(z.string()),
  SNOWFLAKE_ACCOUNT_URL: optional(z.url()),
  SNOWFLAKE_PAT: optional(z.string()),
  SNOWFLAKE_DATABASE: optional(z.string()),
  SNOWFLAKE_SCHEMA: optional(z.string()),
  SNOWFLAKE_CORTEX_SEARCH_SERVICE: optional(z.string()),

  ENABLE_DECISIONS_API: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names only — never echo values, which may be secrets.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid environment: ${fields.join(", ")}`);
  }
  return parsed.data;
}

/** Narrow `config` so `keys` are present, or throw NotConfiguredError naming what's missing. */
export function requireConfig<K extends keyof Config>(
  config: Config,
  feature: string,
  keys: K[],
): Config & { [P in K]-?: NonNullable<Config[P]> } {
  const missing = keys.filter((k) => config[k] === undefined).map(String);
  if (missing.length > 0) throw new NotConfiguredError(feature, missing);
  return config as Config & { [P in K]-?: NonNullable<Config[P]> };
}
