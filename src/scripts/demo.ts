/**
 * `npm run dev:demo` — serves the dashboard and poll widget for a seeded trip that is visibly labeled
 * DEMO DATA, using in-memory Postgres (PGlite). For checking the UI without Photon, Gemini or Tiger Data.
 * Never used by the agent itself.
 */
import { serve } from "@hono/node-server";
import { Engine } from "../agent/engine";
import { KEEP_CURRENT } from "../agent/phases/review";
import type { ChatPort } from "../chat/port";
import { loadConfig } from "../config";
import { createMemoryDb } from "../db/memory";
import { Repo } from "../db/repo";
import { option, withAbstain } from "../domain/reconcile";
import { buildItinerary, type PlacedStop } from "../domain/schedule";
import { createHttpApp } from "../http/app";
import { newId, type ResolvedRequirements } from "../schemas";
import { NominatimGeocoder, OsrmRouter } from "../services/geo";
import { LlmError } from "../services/llm";
import { Planner } from "../services/planner";

const config = loadConfig();
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));
const repo = new Repo(await createMemoryDb());

const RESOLVED: ResolvedRequirements = {
  startLocation: "Chapel Hill, NC",
  endLocation: "Asheville, NC",
  startDate: "2026-10-17",
  endDate: "2026-10-18",
  tripType: "round_trip",
  budgetPerPersonUsd: 150,
  dietaryRestrictions: ["halal"],
  adopted: [{ category: "activities", text: "Visit a waterfall" }],
  decisions: [
    {
      pollId: newId("poll"),
      question: "When are we going?",
      winningLabel: "Sat, Oct 17 – Sun, Oct 18",
      votes: 2,
      voters: 3,
    },
  ],
};

const stop = (
  day: number,
  kind: PlacedStop["kind"],
  name: string,
  lat: number,
  lng: number,
  dwellMinutes: number,
  extra: Partial<PlacedStop> = {},
): PlacedStop => ({
  id: newId("stop"),
  day,
  kind,
  name,
  address: null,
  latLng: { lat, lng },
  geocodeSource: "nominatim",
  dwellMinutes,
  note: "DEMO DATA",
  sustainable: false,
  sourceUrl: null,
  webEstimateCostPerPersonUsd: null,
  ...extra,
});

const stops: PlacedStop[] = [
  stop(1, "origin", "Chapel Hill, NC", 35.9132, -79.0558, 0),
  stop(1, "restaurant", "Halal lunch (demo)", 36.0726, -79.792, 60, { webEstimateCostPerPersonUsd: 16 }),
  stop(1, "rest_stop", "I-40 rest area (demo)", 35.7826, -80.8873, 15),
  stop(1, "gas", "Gas stop (demo)", 35.684, -82.0093, 10),
  stop(1, "scenic", "Looking Glass Falls", 35.2965, -82.7695, 75, { sustainable: true }),
  stop(1, "destination", "Asheville, NC", 35.5951, -82.5515, 120, {
    sustainable: true,
    note: "Walk downtown (DEMO DATA)",
  }),
  stop(1, "lodging", "Downtown hotel (demo)", 35.5946, -82.554, 0, { webEstimateCostPerPersonUsd: 60 }),
  stop(2, "scenic", "Craggy Gardens", 35.699, -82.38, 60, { sustainable: true }),
  stop(2, "restaurant", "Farm-to-table lunch (demo)", 35.6009, -82.3176, 60, {
    sustainable: true,
    webEstimateCostPerPersonUsd: 20,
  }),
  stop(2, "origin", "Home: Chapel Hill, NC", 35.9132, -79.0558, 0),
];

const { trip, host } = await repo.createTrip({
  title: "DEMO DATA — Blue Ridge sample",
  timeZone: config.TRIP_TIMEZONE,
  hostHandle: "+10000000001",
  hostChatId: null,
});
await repo.updateMember(host.id, { name: "Alex" });
for (const [handle, name] of [
  ["+10000000002", "Sam"],
  ["+10000000003", "Jordan"],
] as const) {
  const { member } = await repo.addInvite(trip.id, handle);
  await repo.joinMember(member.id, null);
  await repo.updateMember(member.id, { name });
}
await repo.updateTrip(trip.id, { resolved: RESOLVED });
const router = new OsrmRouter(config.OSRM_URL, config.GEO_USER_AGENT, fetch, log);
const itinerary = buildItinerary({
  tripId: trip.id,
  version: 1,
  title: "DEMO DATA — Blue Ridge sample",
  timeZone: config.TRIP_TIMEZONE,
  resolved: RESOLVED,
  stops,
  legs: await router.route(stops),
  dayDepartTimes: new Map([
    [1, "08:30"],
    [2, "09:00"],
  ]),
  memberCount: 3,
  vehicleMpg: config.VEHICLE_MPG,
  gasPriceUsdPerGallon: config.GAS_PRICE_USD_PER_GALLON,
  rationale: "DEMO DATA",
  droppedStops: [],
});
await repo.saveItinerary(itinerary, null);
await repo.transition(trip.id, "onboarding", "execution");

const [poll] = await repo.createPolls([
  {
    tripId: trip.id,
    kind: "itinerary",
    question: "DEMO: Add a sunset stop on the Parkway?",
    status: "open",
    round: 1,
    options: withAbstain([
      option("Yes, add a sunset overlook", { kind: "itinerary", instruction: "Add a sunset overlook on day 1" }),
      option("Keep the current plan", { kind: "itinerary", instruction: KEEP_CURRENT }),
    ]),
  },
]);
const token = poll ? await repo.pollToken(poll.id, host.id) : null;

const logChat: ChatPort = {
  async sendText(to, text) {
    log("demo_chat_text", { to: to.handle, text });
  },
  async sendCard(to, url) {
    log("demo_chat_card", { to: to.handle, url });
    return null;
  },
  async editCard(_to, card) {
    return card;
  },
};
const engine = new Engine({
  repo,
  chat: logChat,
  llm: { generate: (r) => Promise.reject(new LlmError(r.task, "demo has no Gemini")) },
  planner: new Planner({
    llm: { generate: (r) => Promise.reject(new LlmError(r.task, "demo has no Gemini")) },
    geocoder: new NominatimGeocoder(config.NOMINATIM_URL, config.GEO_USER_AGENT),
    router,
    vehicleMpg: config.VEHICLE_MPG,
    gasPriceUsdPerGallon: config.GAS_PRICE_USD_PER_GALLON,
  }),
  config: {
    publicBaseUrl: null,
    minMembers: 1,
    timeZone: config.TRIP_TIMEZONE,
    vehicleMpg: config.VEHICLE_MPG,
    gasPriceUsdPerGallon: config.GAS_PRICE_USD_PER_GALLON,
  },
  log,
});

const app = createHttpApp({ repo, engine });
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  const base = `http://localhost:${info.port}`;
  console.log(
    `\nDEMO DATA server (in-memory, nothing is persisted)\n  dashboard: ${base}/trip/${trip.publicId}\n  poll:      ${base}/poll/${token}\n  routing:   ${itinerary.routeSource}\n`,
  );
});
