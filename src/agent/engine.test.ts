import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join_ } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb } from "../db/memory";
import { Repo } from "../db/repo";
import type { ItineraryDraft } from "../schemas";
import type { LlmRequest } from "../services/llm";
import { Planner } from "../services/planner";
import { FakeChat, FakeDecider, FakeGeocoder, FakeLlm, FakeRouter } from "../testing/fakes";
import { Engine, type EngineDeps } from "./engine";

const ALEX = "+19195550001";
const SAM = "+19195550002";
const BLOCKED = "+19195550099";

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

const GIF = join_(tmpdir(), "road-trip-agent-test-dap.gif");

function makeEngine(
  overrides: Partial<ConstructorParameters<typeof Engine>[0]["config"]> = {},
  deps: Partial<EngineDeps> = {},
): Engine {
  const planner = new Planner({
    llm,
    geocoder: new FakeGeocoder(),
    router: new FakeRouter(),
    vehicleMpg: 30,
    gasPriceUsdPerGallon: 3.2,
  });
  return new Engine({
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
      dapGifPath: GIF,
      ...overrides,
    },
    clock: () => now,
    ...deps,
  });
}

beforeEach(async () => {
  await writeFile(GIF, "GIF89a");
  chat = new FakeChat();
  chat.blocked.add(BLOCKED);
  llm = new FakeLlm();
  decider = new FakeDecider();
  repo = new Repo(await createMemoryDb());
  now = new Date("2026-10-10T14:00:00Z");
  engine = makeEngine();
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
  expect(chat.lastTextTo(ALEX)).toBe("Hey Alex! 📍 Where from, and where to?\ne.g. Chapel Hill to Wilmington");

  await say(SAM, `join ${trip.inviteCode.toLowerCase()}`);
  expect(chat.lastTextTo(SAM)).toBe("🎉 You're in Alex's trip! What's your first name?");
  await say(SAM, "Sam");
  expect(chat.lastTextTo(SAM)).toBe("Hey Sam! 📍 Where to? e.g. Asheville");
  expect(chat.lastTextTo(ALEX)).toBe("👋 Sam joined!");
}

/** Background place cleanup: "Asheville" → "Asheville, NC". */
function canonicalizePlaces(): void {
  llm.on("place_canonicalization", (req: LlmRequest<unknown>) => {
    const [, start = "", end = ""] = req.prompt.match(/Start: (.*)\nEnd: (.*)/) ?? [];
    const st = (p: string) => (p.includes(",") ? p : `${p}, NC`);
    return { startLocation: st(start), endLocation: st(end) };
  });
}

/** Both members answer the grouped questions; Alex's are all read deterministically. */
async function answer(): Promise<void> {
  canonicalizePlaces();
  await say(ALEX, "Chapel Hill to Asheville");
  expect(chat.lastTextTo(ALEX)).toBe("👍 Chapel Hill → Asheville\n📅 When? e.g. Oct 18–19");
  await say(ALEX, "oct 17-18");
  expect(chat.lastTextTo(ALEX)).toMatch(/^👍 Sat, Oct 17 – Sun, Oct 18\n💵 Budget per person/);
  await say(ALEX, "$200, halal");
  expect(chat.lastTextTo(ALEX)).toMatch(/^👍 \$200\/person · halal\n✨ Anything else/);
  // Instant replies: the only Gemini call is the background place cleanup.
  expect(llm.calls.map((c) => c.task)).toEqual(["place_canonicalization"]);

  decider.onChoose("wish_category", { value: "activities", confidence: 0.9 });
  await say(ALEX, "a waterfall hike");
  expect(chat.lastTextTo(ALEX)).toBe(
    "✅ You're all set!\n• 📍 Chapel Hill, NC → Asheville, NC\n• 📅 Sat, Oct 17 – Sun, Oct 18\n• 💵 $200 · 🥗 halal\n• ✨ a waterfall hike\n⏳ Waiting on Sam…",
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
  expect(chat.lastTextTo(SAM)).toBe("👍 Chapel Hill, NC → Boone, NC\n📅 When? e.g. Oct 18–19");
  expect(chat.typingTo).toContain(SAM);
  await say(SAM, "Octobr 24 to 25");
  expect(chat.lastTextTo(SAM)).toMatch(/^👍 Sat, Oct 24 – Sun, Oct 25/);
  await say(SAM, "150 bucks, no restrictions");
  expect(chat.lastTextTo(SAM)).toMatch(/^👍 \$150\/person · no dietary restrictions\n✨/);
}

describe("Engine end to end", () => {
  it("takes first names from Photon and gives guests the host's starting point", async () => {
    const photon: Record<string, string> = { [ALEX]: "Alex", [SAM]: "Sam" };
    engine = makeEngine({}, { names: { firstName: async (handle) => photon[handle] ?? null } });
    canonicalizePlaces();

    await say(ALEX, "new trip");
    const trip = await tripOf(ALEX);
    expect(chat.textsTo(ALEX)).toEqual([
      "🚗 Trip started! Send the join message to your friends to join the trip!",
      `join ${trip.inviteCode}`,
      "Hey Alex! 📍 Where from, and where to?\ne.g. Chapel Hill to Wilmington",
    ]);
    await say(ALEX, "Chapel Hill to Asheville");

    await say(SAM, `join ${trip.inviteCode}`);
    expect(chat.lastTextTo(SAM)).toBe(
      "🎉 You're in Alex's trip, Sam!\n📍 Where to? e.g. Asheville\n(leaving from Chapel Hill, NC)",
    );
    expect(chat.lastTextTo(ALEX)).toBe("👋 Sam joined!");
    await say(SAM, "boone");
    expect(chat.lastTextTo(SAM)).toBe("👍 Chapel Hill, NC → Boone\n📅 When? e.g. Oct 18–19");
    const sam = await repo.findActiveMembership(SAM);
    expect(await repo.getPredefined(sam?.member.id as string)).toMatchObject({
      startLocation: "Chapel Hill, NC",
      endLocation: "Boone, NC",
      tripType: "round_trip",
    });
    expect(chat.textsTo(SAM).some((t) => t.includes("first name"))).toBe(false);
  });

  it("runs join → grouped answers → vote → drafting → review → execution", async () => {
    await join();
    await answer();

    // Sam has no extra wishes → both are done → voting starts on the differing route and dates, and
    // Gemini researches all four possible outcomes while they vote.
    llm.on("itinerary_draft", DRAFT);
    await say(SAM, "nope");
    const drafts = () => llm.calls.filter((c) => c.task === "itinerary_draft").length;
    expect(drafts()).toBe(4);
    const trip = await tripOf(ALEX);
    expect(trip.phase).toBe("voting");
    const settled = chat.textsTo(ALEX).find((t) => t.startsWith("🧮 Everyone's in!")) ?? "";
    expect(settled).toContain("• 💵 $150/person (lowest budget)");
    expect(settled).toContain("• 🥗 halal");
    expect(settled).toContain("• ✨ a waterfall hike");
    expect(chat.lastTextTo(SAM)).toBe(
      "🗳️ Where are we going?\n1️⃣ Asheville, NC\n2️⃣ Boone, NC\n3️⃣ Either works for me\nReply with a number",
    );
    expect(chat.sent.some((m) => m.card?.url.includes("/poll/"))).toBe(false); // POLL_WIDGET off

    // Route poll: Alex by number, Sam in their own words (mapped by OpenAI Decisions, no Gemini call).
    decider.onChoose("vote_mapping", (q) => {
      const c = q.choices.find((o) => o.description.includes("Asheville"));
      return c ? { value: c.value, confidence: 0.95 } : null;
    });
    await say(ALEX, "1");
    expect(chat.lastTextTo(ALEX)).toBe("🗳️ Got it: Asheville, NC (1/2 in)");
    await say(SAM, "asheville sounds better tbh");
    expect(llm.calls.some((c) => c.task === "vote_mapping")).toBe(false);
    expect(chat.textsTo(ALEX)).toContain("📊 Asheville, NC wins! (2/2)");
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
    decider.onChoose("destination_vibe", { value: "beach", confidence: 0.8 });
    const abstain = datesPoll?.options.find((o) => o.value.kind === "abstain");
    const result = await engine.submitWidgetVote(samToken, { optionId: abstain?.id as string });
    expect(result).toMatchObject({ ok: true });
    await engine.settled();
    // The winner's research was already done: no new draft call, and one wish needs no conflict check.
    expect(drafts()).toBe(4);
    expect(llm.calls.some((c) => c.task === "conflict_analysis")).toBe(false);

    // No review step: the trip goes straight to the road. Each phone gets, in order: ready, the card,
    // a send-off that fits the destination (OpenAI Decisions: mountains) and the dap GIF.
    const live = await tripOf(ALEX);
    expect(live.phase).toBe("execution");
    expect(live.resolved).toMatchObject({
      endLocation: "Asheville, NC",
      startDate: "2026-10-17",
      budgetPerPersonUsd: 150,
      dietaryRestrictions: ["halal"],
      adopted: [{ category: "activities", text: "a waterfall hike" }],
    });
    for (const who of [ALEX, SAM]) {
      expect(chat.timeline(who).slice(-4)).toEqual([
        "✅ Itinerary ready!",
        "[card]",
        "🏖️ You're set for Asheville!\nEnjoy the waves — and don't forget to pack sunscreen 🧴😎",
        "[file road-trip-agent-test-dap.gif]",
      ]);
    }
    expect(chat.textsTo(ALEX).some((t) => t.includes("Looking Glass Falls"))).toBe(false); // no itinerary text
    const v1 = await repo.getItinerary(live.id, 1);
    expect(v1?.stops[0]?.kind).toBe("origin");
    expect(v1?.stops.at(-1)?.name).toBe("Home: Chapel Hill, NC");
    expect(v1?.stops[1]?.departAt).toMatch(/^2026-10-17T/);

    // On the road: running late at lunch shifts the rest of the day and edits the cards.
    const lunch = v1?.stops.find((s) => s.name === "Halal Grill");
    now = new Date(Date.parse(lunch?.arriveAt as string) + 30 * 60_000);
    llm.on("live_update", { kind: "delay", delayMinutes: 30, stopId: lunch?.id, request: null, reply: null });
    await say(SAM, "we took longer at lunch, push everything back 30 min");
    const v2 = await repo.getItinerary(live.id, 2);
    const lunchV2 = v2?.stops.find((s) => s.name === "Halal Grill");
    expect(Date.parse(lunchV2?.departAt as string) - Date.parse(lunch?.departAt as string)).toBe(30 * 60_000);
    expect(chat.lastTextTo(ALEX)).toContain("running 30 min behind at Halal Grill");
    expect(chat.timeline(ALEX).at(-1)).toBe("[card edit]");
  });

  it("with REVIEW_STEP, everyone approves first; feedback revises the card", async () => {
    engine = makeEngine({ reviewStep: true });
    await join();
    canonicalizePlaces();
    for (const who of [ALEX, SAM]) {
      await say(who, "Chapel Hill to Asheville");
      await say(who, "oct 17-18");
      await say(who, "$200, halal");
    }
    llm.on("itinerary_draft", DRAFT);
    await say(ALEX, "nope");
    await say(SAM, "nope"); // everyone agrees → no poll → drafting → review
    const trip = await tripOf(ALEX);
    expect(trip.phase).toBe("review");
    expect(chat.timeline(SAM).slice(-3)).toEqual([
      "✅ Itinerary ready!",
      "[card]",
      "Reply `approve` 👍 or tell me what to change.",
    ]);

    // Minor feedback → v2, approvals carry over; the diff is texted and the card edited in place.
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
    expect(v2trip.currentVersion).toBe(2);
    expect(await repo.listApprovals(v2trip.id, 2)).toHaveLength(1);
    expect(chat.textsTo(ALEX).some((t) => t.startsWith("✏️ Plan updated (v2)"))).toBe(true);
    expect(chat.timeline(ALEX).at(-1)).toBe("[card edit]");

    // Sam approves → execution: send-off (no Decider answer → generic line) and the GIF.
    await say(SAM, "approve");
    expect((await tripOf(ALEX)).phase).toBe("execution");
    expect(chat.timeline(SAM).slice(-3)).toEqual([
      "🎉 Everyone approved! Trippy's gassed up and ready to roll.",
      "🚗 You're set for Asheville!\nEnjoy the ride — and queue up a good playlist 🎶",
      "[file road-trip-agent-test-dap.gif]",
    ]);
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

describe("Photos", () => {
  const PNG = { mimeType: "image/png", data: Buffer.from("fake-png") };
  const FALAFEL = {
    kind: "place",
    placeName: "Gypsy Queen Cuisine",
    city: "Asheville, NC",
    description: "Lebanese food truck praised for its falafel.",
    category: "food",
  };
  const WATERFALL = {
    kind: "scene",
    placeName: null,
    city: null,
    description: "Tall forest waterfall with a swimming hole",
    category: "activities",
  };

  /** As the chat runtime does: the photo is recorded in `chat_events`, then the engine handles it. */
  async function sendPhoto(handle: string): Promise<void> {
    const messageId = `m${++counter}`;
    const active = await repo.findActiveMembership(handle);
    await repo.recordChatEvent({
      eventId: messageId,
      occurredAt: now,
      chatId: `any;-;${handle}`,
      tripId: active?.trip.id ?? null,
      memberId: active?.member.id ?? null,
      direction: "inbound",
      handle,
      kind: "attachment",
      text: null,
      content: { type: "attachment", name: "photo.png", mimeType: "image/png", size: 8 },
      metadata: {},
    });
    await engine.receive({ messageId, handle, chatId: `any;-;${handle}`, text: "", receivedAt: now, image: PNG });
    await engine.settled();
  }

  const wishesOf = async (handle: string) => (await repo.listOptional((await tripOf(handle)).id)).map((r) => r.text);

  it("turns a screenshot of a post into a 'visit' wish mid-questions, then asks the next question", async () => {
    await join();
    llm.on("image_interpretation", FALAFEL);
    await sendPhoto(SAM);
    expect(chat.textsTo(SAM).at(-2)).toContain("taking a look");
    expect(chat.lastTextTo(SAM)).toBe(
      "📸 Lebanese food truck praised for its falafel. Added to your wishes: “Visit Gypsy Queen Cuisine, Asheville, NC”.\n📍 Where to? e.g. Asheville",
    );
    expect(llm.calls.at(-1)).toMatchObject({ task: "image_interpretation", images: 1 });
    expect(await wishesOf(SAM)).toEqual(["Visit Gypsy Queen Cuisine, Asheville, NC"]);
    expect((await repo.findActiveMembership(SAM))?.member.requirementsReady).toBe(false);
  });

  it("a photo can answer 'Anything else?'; its caption afterwards adds nothing and isn't a vote", async () => {
    await join();
    await answer(); // Alex is done; Sam is at "Anything else?"
    llm.on("itinerary_draft", DRAFT);
    llm.on("image_interpretation", WATERFALL);
    await sendPhoto(SAM);
    expect(chat.textsTo(SAM)).toContain(
      "📸 Tall forest waterfall with a swimming hole. I'll look for stops like that — added to your wishes: “Include stops similar to: Tall forest waterfall with a swimming hole”.",
    );
    expect(chat.textsTo(SAM).some((t) => t.startsWith("✅ You're all set!"))).toBe(true);
    expect((await tripOf(SAM)).phase).toBe("voting"); // Sam finished → the vote started

    const sent = chat.textsTo(SAM).length;
    await say(SAM, "try to include stops similar to this");
    expect(chat.textsTo(SAM)).toHaveLength(sent); // dropped: no reply, no vote
    expect((await wishesOf(SAM)).filter((w) => w.startsWith("Include stops similar to"))).toHaveLength(1);
  });

  it("asks for the picture when the caption comes first, and ignores unrelated images", async () => {
    await join();
    await answer();
    await say(SAM, "try to include stops similar to this");
    expect(chat.lastTextTo(SAM)).toContain("Send the picture");
    expect((await repo.findActiveMembership(SAM))?.member.requirementsReady).toBe(false);

    llm.on("image_interpretation", { ...WATERFALL, kind: "unrelated", description: "A selfie", category: "other" });
    await sendPhoto(SAM);
    expect(chat.lastTextTo(SAM)).toContain("couldn't spot a place");
    expect(await wishesOf(SAM)).toEqual(["a waterfall hike"]); // only Alex's wish
  });

  it("turns a photo into itinerary feedback during review, and declines photos on the road", async () => {
    engine = makeEngine({ reviewStep: true });
    await join();
    canonicalizePlaces();
    for (const who of [ALEX, SAM]) {
      await say(who, "Chapel Hill to Asheville");
      await say(who, "oct 17-18");
      await say(who, "$200, halal");
    }
    llm.on("itinerary_draft", DRAFT);
    await say(ALEX, "nope");
    await say(SAM, "nope");
    expect((await tripOf(ALEX)).phase).toBe("review");

    llm.on("image_interpretation", { ...WATERFALL, description: "Mountain overlook at sunset", category: "stops" });
    llm.on("feedback_assessment", {
      impact: "minor",
      summary: "Add a sunset overlook",
      instruction: "Add a mountain overlook stop near sunset",
      pollQuestion: null,
      pollOptions: [],
    });
    await sendPhoto(ALEX);
    const feedbackCall = llm.calls.find((c) => c.task === "feedback_assessment");
    expect(feedbackCall?.prompt).toContain("Add stops similar to: Mountain overlook at sunset");
    expect(chat.textsTo(ALEX)).toContain("📸 Mountain overlook at sunset.");
    expect((await tripOf(ALEX)).currentVersion).toBe(2);

    // A caption sent before its photo (minutes later, so not this photo's caption) waits for the photo.
    now = new Date(now.getTime() + 5 * 60_000);
    llm.set("feedback_assessment", {
      impact: "minor",
      summary: "",
      instruction: "",
      pollQuestion: null,
      pollOptions: [],
      awaitingPhoto: true,
    });
    await say(ALEX, "add something like this");
    expect(chat.lastTextTo(ALEX)).toContain("Send the picture");
    expect((await tripOf(ALEX)).currentVersion).toBe(2);

    const trip = await tripOf(ALEX);
    await repo.transition(trip.id, "review", "execution");
    await sendPhoto(ALEX);
    expect(chat.lastTextTo(ALEX)).toContain("while we're planning or reviewing");
  });
});
