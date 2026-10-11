import { z } from "zod";
import { NotConfiguredError } from "./errors";
import { IanaTimeZone } from "./schemas";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess((v) => blankToUndefined(v) ?? fallback, schema);

const envSchema = z.object({
  PORT: withDefault(z.coerce.number().int().min(1).max(65535), 8787),
  PUBLIC_BASE_URL: z.preprocess(
    blankToUndefined,
    z
      .url()
      .transform((u) => u.replace(/\/+$/, ""))
      .optional(),
  ),
  SPECTRUM_PROJECT_ID: optionalString,
  SPECTRUM_PROJECT_SECRET: optionalString,
  /** Spectrum REST API (the users list supplies first names). Same variable the SDK reads. */
  SPECTRUM_CLOUD_URL: withDefault(
    z.url().transform((u) => u.replace(/\/+$/, "")),
    "https://spectrum.photon.codes",
  ),
  DATABASE_URL: optionalString,
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: withDefault(z.string().min(1), "gemini-3.8-flash"),
  TRIP_TIMEZONE: withDefault(IanaTimeZone, "America/New_York"),
  VEHICLE_MPG: withDefault(z.coerce.number().positive().max(200), 30),
  GAS_PRICE_USD_PER_GALLON: withDefault(z.coerce.number().positive().max(20), 3.2),
  MIN_MEMBERS: withDefault(z.coerce.number().int().min(1).max(10), 2),
  /**
   * Photon card style. `false` (default): a normal bubble that opens the mini-app in iMessage's expanded,
   * near-full-screen view when tapped. `true`: a live card rendered inline in the thread (bubble-sized).
   */
  CARD_LIVE: withDefault(
    z.enum(["true", "false"]).transform((v) => v === "true"),
    "false",
  ),
  /** Nudge members the trip is waiting on (15 s after an unanswered message, then 1, 4, 16, 64 min). */
  REMINDERS: withDefault(
    z.enum(["true", "false"]).transform((v) => v === "true"),
    "true",
  ),
  /** `false`: the first itinerary goes straight to the road (no approve round). `true`: everyone approves first. */
  REVIEW_STEP: withDefault(
    z.enum(["true", "false"]).transform((v) => v === "true"),
    "false",
  ),
  /** Also send each voter a poll-widget card. Off: votes are iMessage replies only (the widget code stays). */
  POLL_WIDGET: withDefault(
    z.enum(["true", "false"]).transform((v) => v === "true"),
    "false",
  ),
  /** GIF sent with the send-off when the itinerary is ready (skipped if the file is missing). */
  DAP_GIF_PATH: withDefault(z.string().min(1), "assets/dap.gif"),
  /** OpenAI Decisions API (fast constrained choices). Without a key every decision falls back to Gemini. */
  OPENAI_API_KEY: optionalString,
  OPENAI_DECISIONS_MODEL: withDefault(z.string().min(1), "gpt-6-luna"),
  NOMINATIM_URL: withDefault(z.url(), "https://nominatim.openstreetmap.org"),
  /** Komoot Photon (OSM) — parallel geocoding first, Nominatim as the fallback. */
  PHOTON_URL: withDefault(z.url(), "https://photon.komoot.io"),
  OSRM_URL: withDefault(z.url(), "https://router.project-osrm.org"),
  /** Nominatim's usage policy requires an identifying User-Agent. */
  GEO_USER_AGENT: withDefault(
    z.string().min(1),
    "road-trip-agent/0.1 (HackNC 2026; github.com/RameezMilk/road-trip-agent)",
  ),
});

export type Config = z.infer<typeof envSchema>;

/** Validates the environment. Never prints values, only the names of invalid keys. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid environment: ${keys.join(", ")}`);
  }
  return parsed.data;
}

export function requireConfig<K extends keyof Config>(
  config: Config,
  feature: string,
  keys: K[],
): Config & { [P in K]-?: NonNullable<Config[P]> } {
  const missing = keys.filter((k) => config[k] === undefined || config[k] === null);
  if (missing.length) throw new NotConfiguredError(feature, missing as string[]);
  return config as Config & { [P in K]-?: NonNullable<Config[P]> };
}
