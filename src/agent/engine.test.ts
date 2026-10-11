import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb } from "../db/memory";
import { Repo } from "../db/repo";
import type { ItineraryDraft } from "../schemas";
import type { LlmRequest } from "../services/llm";
import { Planner } from "../services/planner";
import { FakeChat, FakeGeocoder, FakeLlm, FakeRouter } from "../testing/fakes";
import { Engine } from "./engine";

const ALEX = "+19195550001";
const SAM = "+19195550002";
const BLOCKED = "+19195550099";

/** Pulls `[id] label` pairs out of a prompt so scripted answers can reference real IDs. */
function idsIn(prompt: string): Array<{ id: string; label: string }> {
  return [...prompt.matchAll(/\[((?:opt|req|stop)_[A-Za-z0-9]+)\]\s*(.*)/g)].map((m) => ({
    id: m[1] as string,
    label: (m[2] as string).trim(),
  }));
}

const stop = (name: string, kind: string, dwellMinutes: number, extra: Record<string, unknown> = {}) => ({
  name,
  kind,
  addressQuery: `${name}, NC`,
  city: "Asheville, NC",
  dwellMinutes,
  note: `${name} note`,
  sustainable: kind === "scenic",
  sourceUrl: null,
  estCostPerPersonUsd: kind === "restaurant" ? 18 : null,
  ...extra,
});

const DRAFT: ItineraryDraft = {
  title: "Blue Ridge Fall Break",
  rationale: "Halal lunch, a waterfall hike and plenty of rest stops.",
  days: [
    {
      day: 1,
      departTime: "08:30",
      stops: [
        stop("Halal Grill", "restaurant", 60),
        stop("I-40 Rest Area", "rest_stop", 15),
        stop("Looking Glass Falls", "scenic", 90),
        stop("Asheville, NC", "destination", 0),
        stop("Asheville Inn", "lodging", 0),
      ] as ItineraryDraft["days"][number]["stops"],
    },
    {
      day: 2,
      departTime: "09:00",
      stops: [stop("Mountain Gas", "gas", 10)] as ItineraryDraft["days"][number]["stops"],
    },
  ],
};

let chat: FakeChat;
let llm: FakeLlm;
let repo: Repo;
let engine: Engine;
let now: Date;
let counter = 0;

async function say(handle: string, text: string): Promise<void> {
  await engine.receive({ messageId: `m${++counter}`, handle, chatId: `any;-;${handle}`, text, receivedAt: now });
  await engine.settled();
}

beforeEach(async () => {
  chat = new FakeChat();
  chat.blocked.add(BLOCKED);
  llm = new FakeLlm();
  repo = new Repo(await createMemoryDb());
  now = new Date("2026-10-10T14:00:00Z");
  const planner = new Planner({
    llm,
    geocoder: new FakeGeocoder(),
    router: new FakeRouter(),
    vehicleMpg: 30,
    gasPriceUsdPerGallon: 3.2,
  });
  engine = new Engine({
    repo,
    chat,
    llm,
    planner,
    config: {
      publicBaseUrl: "https://trip.example",
      minMembers: 2,
      timeZone: "America/New_York",
      vehicleMpg: 30,
      gasPriceUsdPerGallon: 3.2,
    },
    clock: () => now,
  });
});

async function tripOf(handle: string) {
  const active = await repo.findActiveMembership(handle);
  if (!active) throw new Error(`${handle} has no trip`);
  return active.trip;
}

async function onboard(): Promise<void> {
  await say(ALEX, "newtrip Fall break");
  expect(chat.lastTextTo(ALEX)).toContain("first name");
  await say(ALEX, "I'm alex");
  expect(chat.lastTextTo(ALEX)).toContain("Nice to meet you, Alex");

  await say(ALEX, `invite 919-555-0002, ${BLOCKED}`);
  expect(chat.lastTextTo(SAM)).toContain("Alex invited you");
  expect(chat.lastTextTo(ALEX)).toContain("can't message …0099");

  await say(SAM, "hey what's this?");
  expect(chat.lastTextTo(SAM)).toContain("Reply `join`");
  await say(SAM, "join");
  await say(SAM, "Sam");
  expect(chat.lastTextTo(ALEX)).toContain("Sam joined the trip (2/2 in)");

  await say(ALEX, "ready");
  expect(chat.lastTextTo(ALEX)).toContain("Waiting on: Sam");
  await say(SAM, "Ready!");
  expect((await tripOf(ALEX)).phase).toBe("planning");
  expect(chat.lastTextTo(SAM)).toContain("Where are you starting from?");
}

async function plan(): Promise<void> {
  llm.on(
    "predefined_extraction",
    {
      startLocation: "Chapel Hill, NC",
      endLocation: "Asheville, NC",
      startDate: "2026-10-17",
      endDate: "2026-10-18",
      tripType: "round_trip",
      budgetPerPersonUsd: null,
      dietaryRestrictions: null,
    },
    {
      startLocation: null,
      endLocation: null,
      startDate: null,
      endDate: null,
      tripType: null,
      budgetPerPersonUsd: null,
      dietaryRestrictions: ["halal"],
    },
    {
      startLocation: "Chapel Hill, NC",
      endLocation: "Boone, NC",
      startDate: "2026-10-24",
      endDate: "2026-10-25",
      tripType: "round_trip",
      budgetPerPersonUsd: 150,
      dietaryRestrictions: [],
    },
  );
  await say(ALEX, "Chapel Hill to Asheville, Oct 17-18, there and back");
  expect(chat.lastTextTo(ALEX)).toContain("budget per person");
  await say(ALEX, "$200");
  expect(chat.lastTextTo(ALEX)).toContain("dietary restrictions");
  await say(ALEX, "I eat halal");
  expect(chat.lastTextTo(ALEX)).toContain("Must-haves saved");

  await say(SAM, "Chapel Hill to Boone Oct 24-25 round trip, 150 bucks, no restrictions");
  expect(chat.lastTextTo(SAM)).toContain("Must-haves saved");

  llm.on("optional_extraction", { requirements: [{ category: "activities", text: "Visit a waterfall" }] });
  await say(ALEX, "I'd love a waterfall hike");
  expect(chat.lastTextTo(ALEX)).toContain("Noted: Visit a waterfall");

  await say(ALEX, "ready");
  expect(chat.lastTextTo(SAM)).toContain("Alex is ready (1/2)");
}

describe("Engine end to end", () => {
  it("runs onboarding → planning → voting → drafting → review → execution", async () => {
    await onboard();
    await plan();

    // Sam readies up without optional wishes → voting starts with the two differing must-haves.
    await say(SAM, "ready");
    const trip = await tripOf(ALEX);
    expect(trip.phase).toBe("voting");
    const settled = chat.textsTo(ALEX).find((t) => t.includes("Here's what's settled")) ?? "";
    expect(settled).toContain("Budget: $150/person");
    expect(settled).toContain("Dietary: halal");
    expect(chat.lastTextTo(SAM)).toContain("Vote: Where are we going?");
    expect(chat.sent.some((m) => m.to === SAM && m.card?.url.startsWith("https://trip.example/poll/"))).toBe(true);

    // Route poll: Alex by number, Sam in their own words (mapped by Gemini).
    llm.on("vote_mapping", (req: LlmRequest<unknown>) => ({
      optionId: idsIn(req.prompt).find((o) => o.label.includes("Asheville"))?.id ?? null,
    }));
    await say(ALEX, "1");
    expect(chat.lastTextTo(ALEX)).toContain("Counted: Chapel Hill, NC → Asheville, NC");
    await say(SAM, "asheville sounds better tbh");
    expect(chat.lastTextTo(SAM)).toContain("When are we going?");
    expect(
      chat
        .textsTo(ALEX)
        .some((t) => t.includes("Where are we going? → *Chapel Hill, NC → Asheville, NC (round trip)*")),
    ).toBe(true);

    // Dates poll: tie → revote → Sam says either works (abstain) via the poll widget.
    await say(ALEX, "1");
    await say(SAM, "2");
    expect(chat.lastTextTo(SAM)).toContain("It's a tie");
    await say(ALEX, "1");
    const polls = await repo.listPolls(trip.id);
    const datesPoll = polls.find((p) => p.kind === "dates");
    const samToken = await repo.pollToken(
      datesPoll?.id as string,
      (await repo.findActiveMembership(SAM))?.member.id as string,
    );
    llm.on("conflict_analysis", (req: LlmRequest<unknown>) => ({
      adoptedRequirementIds: idsIn(req.prompt).map((r) => r.id),
      polls: [],
    }));
    llm.on("itinerary_draft", DRAFT);
    const abstain = datesPoll?.options.find((o) => o.value.kind === "abstain");
    const result = await engine.submitWidgetVote(samToken, { optionId: abstain?.id as string });
    expect(result).toMatchObject({ ok: true });
    await engine.settled();

    // Drafting ran in the background and landed in review.
    const reviewTrip = await tripOf(ALEX);
    expect(reviewTrip.phase).toBe("review");
    expect(reviewTrip.resolved).toMatchObject({
      endLocation: "Asheville, NC",
      startDate: "2026-10-17",
      budgetPerPersonUsd: 150,
      dietaryRestrictions: ["halal"],
      adopted: [{ category: "activities", text: "Visit a waterfall" }],
    });
    const v1 = await repo.getItinerary(reviewTrip.id, 1);
    expect(v1?.stops[0]?.kind).toBe("origin");
    expect(v1?.stops.at(-1)?.name).toBe("Home: Chapel Hill, NC");
    expect(v1?.stops[1]?.departAt).toMatch(/^2026-10-17T/);
    expect(chat.lastTextTo(SAM)).toContain("Reply `approve`");
    expect(chat.lastTextTo(SAM)).toContain("Looking Glass Falls");

    // Minor feedback → v2, approvals carry over.
    await say(ALEX, "approve");
    llm.on("feedback_assessment", {
      impact: "minor",
      summary: "More time at the waterfall",
      instruction: "Spend 30 more minutes at Looking Glass Falls",
      pollQuestion: null,
      pollOptions: [],
    });
    await say(SAM, "can we spend a bit more time at the falls?");
    const v2trip = await tripOf(ALEX);
    expect(v2trip.phase).toBe("review");
    expect(v2trip.currentVersion).toBe(2);
    expect(await repo.listApprovals(v2trip.id, 2)).toHaveLength(1);
    expect(chat.lastTextTo(ALEX)).toContain("Updated itinerary (v2)");

    // Sam approves → everyone has → execution with dashboard cards.
    await say(SAM, "approve");
    expect((await tripOf(ALEX)).phase).toBe("execution");
    const cards = chat.sent.filter((m) => m.card?.url.endsWith(`/trip/${v2trip.publicId}`));
    expect(cards.map((c) => c.to).sort()).toEqual([ALEX, SAM]);

    // On the road: running late at lunch shifts the rest of the day and edits the cards.
    const v2 = await repo.getItinerary(v2trip.id, 2);
    const lunch = v2?.stops.find((s) => s.name === "Halal Grill");
    now = new Date(Date.parse(lunch?.arriveAt as string) + 30 * 60_000);
    llm.on("live_update", { kind: "delay", delayMinutes: 30, stopId: lunch?.id, request: null, reply: null });
    await say(SAM, "we took longer at lunch, push everything back 30 min");
    const v3 = await repo.getItinerary(v2trip.id, 3);
    const lunchV3 = v3?.stops.find((s) => s.name === "Halal Grill");
    expect(Date.parse(lunchV3?.departAt as string) - Date.parse(lunch?.departAt as string)).toBe(30 * 60_000);
    expect(chat.lastTextTo(ALEX)).toContain("running 30 min behind at Halal Grill");
    expect(chat.sent.some((m) => m.card?.edited)).toBe(true);

    // Every inbound/outbound message is stored per member — inbound here goes through the engine only,
    // so just check trip events were logged.
    expect((await repo.listTripsInPhase("execution")).map((t) => t.id)).toEqual([v2trip.id]);
  });

  it("aborts when a must-have is still tied after the revote", async () => {
    await onboard();
    await plan();
    await say(SAM, "ready");
    await say(ALEX, "1");
    await say(SAM, "2");
    await say(ALEX, "1");
    await say(SAM, "2");
    const trip = await tripOf(ALEX).catch(() => null);
    expect(trip).toBeNull(); // aborted trips are no longer "active"
    expect(chat.lastTextTo(SAM)).toContain("couldn't agree");
  });

  it("only the host can cancel, and help works for anyone", async () => {
    await say(SAM, "help");
    expect(chat.lastTextTo(SAM)).toContain("Commands:");
    await onboard();
    await say(SAM, "cancel");
    expect(chat.lastTextTo(SAM)).toContain("Only the trip host");
    await say(ALEX, "cancel");
    expect(chat.lastTextTo(SAM)).toContain("cancelled");
  });
});
