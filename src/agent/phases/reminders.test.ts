import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Recipient } from "../../chat/port";
import { createMemoryDb } from "../../db/memory";
import { Repo } from "../../db/repo";
import { Planner } from "../../services/planner";
import { FakeChat, FakeGeocoder, FakeLlm, FakeRouter } from "../../testing/fakes";
import { formatWaited, nameList } from "../copy";
import { Engine } from "../engine";

const ALEX = "+19195550001";
const SAM = "+19195550002";
const SEC = 1000;
const MIN = 60 * SEC;

let repo: Repo;
let chat: FakeChat;
let engine: Engine;
let now: Date;

/** Records outbound texts to `chat_events`, as `SpectrumChat` does in production. */
class RecordingChat extends FakeChat {
  override async sendText(to: Recipient, text: string): Promise<void> {
    await super.sendText(to, text);
    await repo.recordChatEvent({
      eventId: `out-${randomUUID()}`,
      occurredAt: now,
      chatId: to.chatId ?? `any;-;${to.handle}`,
      tripId: to.tripId,
      memberId: to.memberId,
      direction: "outbound",
      handle: to.handle,
      kind: "text",
      text,
      content: {},
      metadata: {},
    });
  }
}

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

async function inbound(handle: string, kind: string, text: string | null): Promise<void> {
  const active = await repo.findActiveMembership(handle);
  await repo.recordChatEvent({
    eventId: `in-${randomUUID()}`,
    occurredAt: now,
    chatId: `any;-;${handle}`,
    tripId: active?.trip.id ?? null,
    memberId: active?.member.id ?? null,
    direction: "inbound",
    handle,
    kind,
    text,
    content: {},
    metadata: {},
  });
}

/** A member texts the agent: recorded like `runtime.ts` does, then the agent answers a second later. */
async function say(handle: string, text: string): Promise<void> {
  await inbound(handle, "text", text);
  advance(SEC);
  await engine.receive({ messageId: randomUUID(), handle, chatId: `any;-;${handle}`, text, receivedAt: now });
  await engine.settled();
}

async function remindersTo(handle: string): Promise<string[]> {
  chat.clear();
  await engine.sweepReminders();
  return chat.textsTo(handle).filter((t) => t.startsWith("⏰"));
}

beforeEach(async () => {
  repo = new Repo(await createMemoryDb());
  chat = new RecordingChat();
  // Phase changes are stamped with the real clock, so the fake clock starts from it.
  now = new Date();
  const llm = new FakeLlm();
  engine = new Engine({
    repo,
    chat,
    llm,
    planner: new Planner({
      llm,
      geocoder: new FakeGeocoder(),
      router: new FakeRouter(),
      vehicleMpg: 30,
      gasPriceUsdPerGallon: 3.2,
    }),
    config: {
      publicBaseUrl: "https://trip.example",
      minMembers: 2,
      timeZone: "America/New_York",
      vehicleMpg: 30,
      gasPriceUsdPerGallon: 3.2,
    },
    clock: () => now,
  });

  // The demo opening: Alex starts the trip and gives his name, then goes quiet; Sam joins and answers
  // everything, so the trip is waiting on Alex. Each reply comes a second after the message it answers.
  await say(ALEX, "new trip");
  const trip = await repo.findActiveMembership(ALEX);
  await say(ALEX, "Alex"); // the agent's reply ("Hey Alex! 📍 Where from…") is what Alex leaves unanswered
  await say(SAM, `join ${trip?.trip.inviteCode}`);
  await say(SAM, "Sam");
  await say(SAM, "asheville");
  await say(SAM, "oct 17-18");
  await say(SAM, "$200, none");
  await say(SAM, "nope"); // Sam is done 6 s after the agent's question to Alex
});

describe("reminders", () => {
  it("backs off ×4 from 15 s and says who is waiting and for how long", async () => {
    advance(8 * SEC);
    expect(await remindersTo(ALEX)).toEqual([]);

    advance(SEC); // 15 s after the unanswered question
    const [first] = await remindersTo(ALEX);
    expect(first).toContain("Hey Alex — Sam is waiting on you to respond (Sam for 10 sec)");
    expect(first).toContain("Where from, and where to?");
    expect(await remindersTo(ALEX)).toEqual([]); // no duplicate
    expect(await remindersTo(SAM)).toEqual([]); // Sam is done

    for (const gap of [1 * MIN, 4 * MIN, 16 * MIN, 64 * MIN]) {
      advance(gap - SEC);
      expect(await remindersTo(ALEX)).toEqual([]);
      advance(SEC);
      expect(await remindersTo(ALEX)).toHaveLength(1);
    }
    advance(1000 * MIN);
    expect(await remindersTo(ALEX)).toEqual([]); // stops after 5

    const trip = await repo.findActiveMembership(ALEX);
    const states = await repo.reminderState(trip?.trip.id ?? "", new Date(0));
    expect(states.get(trip?.member.id ?? "")?.reminderCount).toBe(5);
  });

  it("a reply restarts the cycle; a read receipt doesn't count", async () => {
    advance(20 * SEC);
    expect(await remindersTo(ALEX)).toHaveLength(1);

    await inbound(ALEX, "read", null);
    advance(MIN);
    expect(await remindersTo(ALEX)).toHaveLength(1); // second reminder, the read receipt changed nothing

    await say(ALEX, "status"); // answered by the agent a second later → new unanswered message
    advance(14 * SEC);
    expect(await remindersTo(ALEX)).toEqual([]);
    advance(2 * SEC);
    const [again] = await remindersTo(ALEX);
    expect(again).toContain("Sam is waiting on you");
  });

  it("leaves old unanswered messages alone (an abandoned trip never pings anyone)", async () => {
    advance(3 * 60 * MIN);
    expect(await remindersTo(ALEX)).toEqual([]);
  });

  it("in voting, nudges whoever hasn't voted, with the poll", async () => {
    await say(ALEX, "Chapel Hill to Wilmington");
    await say(ALEX, "oct 17-18");
    await say(ALEX, "$200, none");
    await say(ALEX, "nope"); // everyone's done → a route poll (Asheville vs Wilmington)
    expect((await repo.findActiveMembership(ALEX))?.trip.phase).toBe("voting");
    await say(ALEX, "1");
    advance(20 * SEC);
    const [toSam] = await remindersTo(SAM);
    expect(toSam).toContain("Alex is waiting on you");
    expect(toSam).toContain("🗳️ Where are we going?");
    expect(await remindersTo(ALEX)).toEqual([]); // Alex voted
  });
});

describe("reminder copy", () => {
  it("formats waits and names", () => {
    expect(formatWaited(40 * SEC)).toBe("40 sec");
    expect(formatWaited(4 * MIN + 10 * SEC)).toBe("4 min");
    expect(formatWaited(65 * MIN)).toBe("1 hr 5 min");
    expect(formatWaited(120 * MIN)).toBe("2 hr");
    expect(nameList(["John"])).toBe("John");
    expect(nameList(["John", "Bob"])).toBe("John and Bob");
    expect(nameList(["John", "Bob", "Ann"])).toBe("John, Bob and Ann");
  });
});
