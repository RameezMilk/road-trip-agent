import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb } from "../db/memory";
import { Repo } from "../db/repo";
import type { ItineraryDraft } from "../schemas";
import type { LlmRequest } from "../services/llm";
import { Planner } from "../services/planner";
import { FakeChat, FakeDecider, FakeGeocoder, FakeLlm, FakeRouter } from "../testing/fakes";
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
let decider: FakeDecider;
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
  decider = new FakeDecider();
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
    decider,
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

/** The demo opening: new trip → three bubbles → names → straight into the first question. */
async function join(): Promise<void> {
  await say(ALEX, "new trip");
  const trip = await tripOf(ALEX);
  expect(trip.phase).toBe("planning");
  expect(chat.textsTo(ALEX)).toEqual([
    "🚗 Trip started! Send the join message to your friends to join the trip!",
    `join ${trip.inviteCode}`,
    "What's your first name?",
  ]);
  await say(ALEX, "I'm alex");
  expect(chat.lastTextTo(ALEX)).toContain("Hey Alex! 📍 Where to?");

  await say(SAM, `join ${trip.inviteCode.toLowerCase()}`);
  expect(chat.lastTextTo(SAM)).toBe("🎉 You're in Alex's trip! What's your first name?");
  await say(SAM, "Sam");
  expect(chat.lastTextTo(SAM)).toContain("Hey Sam! 📍 Where to?");
  expect(chat.lastTextTo(ALEX)).toBe("👋 Sam joined!");
}

/** Both members answer the grouped questions; Alex's are all read deterministically. */
async function answer(): Promise<void> {
  await say(ALEX, "Chapel Hill to Asheville");
  expect(chat.lastTextTo(ALEX)).toBe("👍 Chapel Hill → Asheville (round trip)\n📅 When? e.g. Oct 18–19");
  await say(ALEX, "oct 17-18");
  expect(chat.lastTextTo(ALEX)).toMatch(/^👍 Sat, Oct 17 – Sun, Oct 18\n💵 Budget per person/);
  await say(ALEX, "$200, halal");
  expect(chat.lastTextTo(ALEX)).toMatch(/^👍 \$200\/person · halal\n✨ Anything else/);
  expect(llm.calls).toEqual([]);

  decider.onChoose("wish_category", { value: "activities", confidence: 0.9 });
  await say(ALEX, "a waterfall hike");
  expect(chat.lastTextTo(ALEX)).toBe(
    "✅ You're all set!\n• 📍 Chapel Hill → Asheville (round trip)\n• 📅 Sat, Oct 17 – Sun, Oct 18\n• 💵 $200 · 🥗 halal\n• ✨ a waterfall hike\n⏳ Waiting on Sam…",
  );

  // Sam: a sentence (Gemini reads it), a misspelled month, budget + "no restrictions".
  llm.on("predefined_extraction", {
    startLocation: "Chapel Hill, NC",
    endLocation: "Boone, NC",
    startDate: null,
    endDate: null,
    tripType: null,
    budgetPerPersonUsd: null,
    dietaryRestrictions: null,
  });
  await say(SAM, "we wanna go from chapel hill to boone");
  expect(chat.lastTextTo(SAM)).toBe("👍 Chapel Hill, NC → Boone, NC (round trip)\n📅 When? e.g. Oct 18–19");
  expect(chat.typingTo).toContain(SAM);
  await say(SAM, "Octobr 24 to 25");
  expect(chat.lastTextTo(SAM)).toMatch(/^👍 Sat, Oct 24 – Sun, Oct 25/);
  await say(SAM, "150 bucks, no restrictions");
  expect(chat.lastTextTo(SAM)).toMatch(/^👍 \$150\/person · no dietary restrictions\n✨/);
}

describe("Engine end to end", () => {
  it("runs join → grouped answers → vote → drafting → review → execution", async () => {
    await join();
    await answer();

    // Sam has no extra wishes → both are done → voting starts on the differing route and dates.
    await say(SAM, "nope");
    const trip = await tripOf(ALEX);
    expect(trip.phase).toBe("voting");
    const settled = chat.textsTo(ALEX).find((t) => t.startsWith("🧮 Everyone's in!")) ?? "";
    expect(settled).toContain("• 💵 $150/person (lowest budget)");
    expect(settled).toContain("• 🥗 halal");
    expect(chat.lastTextTo(SAM)).toBe(
      "🗳️ Where are we going?\n1️⃣ Chapel Hill → Asheville (round trip)\n2️⃣ Chapel Hill, NC → Boone, NC (round trip)\n3️⃣ Either works for me\nReply with a number",
    );

    // Route poll: Alex by number, Sam in their own words (mapped by OpenAI Decisions, no Gemini call).
    decider.onChoose("vote_mapping", (q) => {
      const c = q.choices.find((o) => o.description.includes("Asheville"));
      return c ? { value: c.value, confidence: 0.95 } : null;
    });
    await say(ALEX, "1");
    expect(chat.lastTextTo(ALEX)).toBe("🗳️ Got it: Chapel Hill → Asheville (round trip) (1/2 in)");
    await say(SAM, "asheville sounds better tbh");
    expect(llm.calls.some((c) => c.task === "vote_mapping")).toBe(false);
    expect(chat.textsTo(ALEX)).toContain("📊 Chapel Hill → Asheville (round trip) wins! (2/2)");
    expect(chat.lastTextTo(SAM)).toContain("🗳️ When are we going?");

    // Dates poll: tie → revote → Sam says either works (abstain) via the poll widget.
    await say(ALEX, "1");
    await say(SAM, "2");
    expect(chat.lastTextTo(SAM)).toContain("🔁 Tie! Revote");
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
      endLocation: "Asheville",
      startDate: "2026-10-17",
      budgetPerPersonUsd: 150,
      dietaryRestrictions: ["halal"],
      adopted: [{ category: "activities", text: "a waterfall hike" }],
    });
    const v1 = await repo.getItinerary(reviewTrip.id, 1);
    expect(v1?.stops[0]?.kind).toBe("origin");
    expect(v1?.stops.at(-1)?.name).toBe("Home: Chapel Hill");
    expect(v1?.stops[1]?.departAt).toMatch(/^2026-10-17T/);

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
    expect(chat.lastTextTo(ALEX)).toContain("Plan updated (v2)");

    // Sam approves → everyone has → execution with dashboard cards.
    await say(SAM, "approve");
    expect((await tripOf(ALEX)).phase).toBe("execution");
    const cards = chat.sent.filter((m) => m.card?.url.endsWith(`/trip/${v2trip.publicId}`) && !m.card.edited);
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
  });

  it("aborts when a must-have is still tied after the revote", async () => {
    await join();
    await answer();
    await say(SAM, "nope");
    await say(ALEX, "1");
    await say(SAM, "2");
    await say(ALEX, "1");
    await say(SAM, "2");
    const trip = await tripOf(ALEX).catch(() => null);
    expect(trip).toBeNull(); // aborted trips are no longer "active"
    expect(chat.lastTextTo(SAM)).toContain("Couldn't agree");
  });

  it("waits for a friend before voting, then starts when the last member finishes", async () => {
    await say(ALEX, "newtrip");
    await say(ALEX, "Alex");
    await say(ALEX, "Chapel Hill to Asheville");
    await say(ALEX, "oct 17-18");
    await say(ALEX, "$200, halal");
    await say(ALEX, "nope");
    expect(chat.lastTextTo(ALEX)).toContain("⏳ Waiting on a friend to join…");
    expect((await tripOf(ALEX)).phase).toBe("planning");

    const trip = await tripOf(ALEX);
    await say(SAM, `join ${trip.inviteCode}`);
    await say(SAM, "Sam");
    await say(SAM, "Chapel Hill to Asheville");
    await say(SAM, "oct 17-18");
    await say(SAM, "$250 none");
    llm.on("itinerary_draft", DRAFT);
    await say(SAM, "that's it");
    // Everyone agrees on route and dates → no poll, straight to drafting.
    expect(chat.textsTo(SAM).some((t) => t.startsWith("🧮 Everyone's in!"))).toBe(true);
    expect((await tripOf(ALEX)).phase).not.toBe("planning");
  });

  it("lets members of a trip that's on the road start and join the next trip", async () => {
    await join();
    const first = await tripOf(ALEX);
    await repo.transition(first.id, "planning", "execution");

    await say(ALEX, "newtrip Round two");
    await say(ALEX, "Alex");
    const second = await tripOf(ALEX);
    expect(second.id).not.toBe(first.id);
    await say(ALEX, "invite 919-555-0002");
    expect(chat.lastTextTo(SAM)).toContain("Alex invited you");
    await say(SAM, "join");
    expect((await tripOf(SAM)).id).toBe(second.id);
  });

  it("only the host can cancel, and help works for anyone", async () => {
    await say(SAM, "help");
    expect(chat.lastTextTo(SAM)).toContain("Commands:");
    await join();
    await say(SAM, "cancel");
    expect(chat.lastTextTo(SAM)).toContain("Only the trip host");
    await say(ALEX, "cancel");
    expect(chat.lastTextTo(SAM)).toContain("cancelled");
  });

  it("reports numbers Photon won't let it message", async () => {
    await join();
    await say(ALEX, `invite ${BLOCKED}`);
    expect(chat.lastTextTo(ALEX)).toContain("Can't message …0099");
  });
});
