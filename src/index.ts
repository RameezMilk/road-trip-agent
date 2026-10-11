import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Engine } from "./agent/engine";
import { runChatLoop } from "./agent/runtime";
import { PhotonUsers } from "./chat/photon-users";
import type { CardLayout, ChatPort, Recipient } from "./chat/port";
import { SpectrumChat } from "./chat/spectrum";
import { loadConfig, requireConfig } from "./config";
import { createDb, MIGRATIONS_DIR } from "./db/client";
import { Repo } from "./db/repo";
import { createHttpApp } from "./http/app";
import type { CardRef } from "./schemas";
import { OpenAiDecider } from "./services/decisions";
import { GeminiLlm } from "./services/gemini";
import { FallbackGeocoder, NominatimGeocoder, OsrmRouter, PhotonGeocoder } from "./services/geo";
import { type Llm, LlmError, type LlmRequest } from "./services/llm";
import { Planner } from "./services/planner";

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

const config = loadConfig();
const { DATABASE_URL } = requireConfig(config, "Tiger Data", ["DATABASE_URL"]);
const { db, close } = createDb(DATABASE_URL);
// biome-ignore lint/suspicious/noExplicitAny: the postgres-js migrator wants its own driver type
await migrate(db as any, { migrationsFolder: fileURLToPath(MIGRATIONS_DIR) });
log("db_ready");
const repo = new Repo(db);

/** Without a key every Gemini step fails loudly with a clear reason (never a silent fixture). */
const unconfiguredLlm: Llm = {
  generate<T>(request: LlmRequest<T>): Promise<T> {
    return Promise.reject(new LlmError(request.task, "Gemini isn't configured (GEMINI_API_KEY)"));
  },
};
const llm = config.GEMINI_API_KEY ? new GeminiLlm(config.GEMINI_API_KEY, config.GEMINI_MODEL, log) : unconfiguredLlm;
if (!config.GEMINI_API_KEY) log("gemini_not_configured");

const decider = config.OPENAI_API_KEY
  ? new OpenAiDecider(config.OPENAI_API_KEY, config.OPENAI_DECISIONS_MODEL, log)
  : undefined;
if (!decider) log("decisions_not_configured", { note: "OPENAI_API_KEY unset — Gemini handles every decision" });

const planner = new Planner({
  llm,
  geocoder: new FallbackGeocoder(
    new PhotonGeocoder(config.PHOTON_URL, config.GEO_USER_AGENT, fetch, log),
    new NominatimGeocoder(config.NOMINATIM_URL, config.GEO_USER_AGENT, fetch, 1100, log),
  ),
  router: new OsrmRouter(config.OSRM_URL, config.GEO_USER_AGENT, fetch, log),
  vehicleMpg: config.VEHICLE_MPG,
  gasPriceUsdPerGallon: config.GAS_PRICE_USD_PER_GALLON,
  maxStops: config.MAX_STOPS,
});

let spectrum: SpectrumChat | null = null;
let names: PhotonUsers | null = null;
if (config.SPECTRUM_PROJECT_ID && config.SPECTRUM_PROJECT_SECRET) {
  names = new PhotonUsers(
    config.SPECTRUM_CLOUD_URL,
    config.SPECTRUM_PROJECT_ID,
    config.SPECTRUM_PROJECT_SECRET,
    fetch,
    log,
  );
  void names.load(); // warm, so the first `new trip` doesn't wait for it
  spectrum = await SpectrumChat.connect({
    projectId: config.SPECTRUM_PROJECT_ID,
    projectSecret: config.SPECTRUM_PROJECT_SECRET,
    repo,
    log,
    cardLive: config.CARD_LIVE,
  });
} else {
  log("spectrum_not_configured", { note: "HTTP only — set SPECTRUM_PROJECT_ID/SECRET to run the agent" });
}

const offlineChat: ChatPort = {
  async sendText(to: Recipient) {
    log("chat_offline_drop", { memberId: to.memberId });
  },
  async sendCard(): Promise<CardRef | null> {
    return null;
  },
  async editCard(_to: Recipient, card: CardRef, _url: string, _layout: CardLayout) {
    return card;
  },
};

const engine = new Engine({
  repo,
  chat: spectrum ?? offlineChat,
  llm,
  planner,
  ...(decider ? { decider } : {}),
  ...(names ? { names } : {}),
  config: {
    publicBaseUrl: config.PUBLIC_BASE_URL ?? null,
    minMembers: config.MIN_MEMBERS,
    timeZone: config.TRIP_TIMEZONE,
    vehicleMpg: config.VEHICLE_MPG,
    gasPriceUsdPerGallon: config.GAS_PRICE_USD_PER_GALLON,
    reviewStep: config.REVIEW_STEP,
    pollWidget: config.POLL_WIDGET,
    dapGifPath: config.DAP_GIF_PATH,
  },
  log,
});
if (!config.PUBLIC_BASE_URL) log("public_base_url_missing", { note: "cards need a public HTTPS URL (ngrok)" });

const app = createHttpApp({ repo, engine: spectrum ? engine : null });
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
  log("http_listening", { port: info.port, publicBaseUrl: config.PUBLIC_BASE_URL ?? null }),
);

if (spectrum) {
  await engine.resumeDrafting();
  if (config.REMINDERS) engine.startReminders();
  runChatLoop({ messages: spectrum.messages(), engine, repo, log }).catch((error) => {
    log("chat_loop_crashed", { error: String(error) });
    process.exit(1);
  });
}

let stopping = false;
/**
 * Graceful: finish in-flight work (a message being handled, a stop swap, an itinerary draft) before
 * disconnecting, capped at 90 s. A second signal exits immediately.
 */
async function shutdown(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  log("shutdown", { signal, draining: true });
  engine.stopReminders();
  await Promise.race([engine.settled(), new Promise((resolve) => setTimeout(resolve, 90_000))]);
  log("shutdown_drained");
  server.close();
  await spectrum?.stop().catch(() => undefined);
  await close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
