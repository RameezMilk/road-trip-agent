import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "../schemas";
import { createMemoryDb } from "./memory";
import { Repo } from "./repo";

let repo: Repo;
beforeEach(async () => {
  repo = new Repo(await createMemoryDb());
});

describe("Repo", () => {
  it("creates a trip with its host and finds the active membership", async () => {
    const { trip, host } = await repo.createTrip({
      title: "Fall break",
      timeZone: "America/New_York",
      hostHandle: "+19195550001",
      hostChatId: "any;-;+19195550001",
    });
    expect(trip.phase).toBe("onboarding");
    expect(host.role).toBe("host");
    const active = await repo.findActiveMembership("+19195550001");
    expect(active?.trip.id).toBe(trip.id);
  });

  it("invites, joins, and only lists onboarding invites as pending", async () => {
    const { trip } = await repo.createTrip({
      title: "t",
      timeZone: "America/New_York",
      hostHandle: "+19195550001",
      hostChatId: null,
    });
    const { member, created } = await repo.addInvite(trip.id, "+19195550002");
    expect(created).toBe(true);
    expect((await repo.addInvite(trip.id, "+19195550002")).created).toBe(false);
    expect(await repo.findPendingInvites("+19195550002")).toHaveLength(1);
    await repo.joinMember(member.id, "any;-;+19195550002");
    expect(await repo.findPendingInvites("+19195550002")).toHaveLength(0);
    expect((await repo.findActiveMembership("+19195550002"))?.member.status).toBe("joined");
  });

  it("changes phase only from the expected phase (compare-and-set)", async () => {
    const { trip } = await repo.createTrip({
      title: "t",
      timeZone: "UTC",
      hostHandle: "+19195550001",
      hostChatId: null,
    });
    expect(await repo.transition(trip.id, "planning", "voting")).toBe(false);
    expect(await repo.transition(trip.id, "onboarding", "planning")).toBe(true);
    expect((await repo.getTrip(trip.id))?.phase).toBe("planning");
  });

  it("dedupes chat events on (event_id, occurred_at)", async () => {
    const event = {
      eventId: "msg-1",
      occurredAt: new Date("2026-10-10T20:00:00Z"),
      chatId: "any;-;+19195550001",
      tripId: null,
      memberId: null,
      direction: "inbound" as const,
      handle: "+19195550001",
      kind: "text",
      text: "newtrip",
      content: { type: "text" },
      metadata: {},
    };
    expect(await repo.recordChatEvent(event)).toBe(true);
    expect(await repo.recordChatEvent(event)).toBe(false);
    expect(await repo.latestChatEvents(10)).toHaveLength(1);
  });

  it("returns a member's recent text conversation, oldest first, excluding the current message", async () => {
    const { trip, host } = await repo.createTrip({
      title: "t",
      timeZone: "UTC",
      hostHandle: "+19195550001",
      hostChatId: null,
    });
    const base = {
      chatId: "c",
      tripId: trip.id,
      memberId: host.id,
      handle: host.handle,
      kind: "text",
      content: {},
      metadata: {},
    };
    await repo.recordChatEvent({
      ...base,
      eventId: "e1",
      occurredAt: new Date("2026-10-10T10:00:00Z"),
      direction: "inbound",
      text: "swap a restaurant",
    });
    await repo.recordChatEvent({
      ...base,
      eventId: "e2",
      occurredAt: new Date("2026-10-10T10:00:05Z"),
      direction: "outbound",
      text: "Which one?",
    });
    await repo.recordChatEvent({
      ...base,
      eventId: "e3",
      occurredAt: new Date("2026-10-10T10:00:10Z"),
      direction: "inbound",
      text: "Gypsy Queen",
    });
    expect(await repo.recentConversation(host.id, "e3")).toEqual([
      { direction: "inbound", text: "swap a restaurant" },
      { direction: "outbound", text: "Which one?" },
    ]);
  });

  it("stores predefined requirements per member and upserts votes", async () => {
    const { trip, host } = await repo.createTrip({
      title: "t",
      timeZone: "UTC",
      hostHandle: "+19195550001",
      hostChatId: null,
    });
    const empty = await repo.getPredefined(host.id);
    expect(empty.startLocation).toBeNull();
    await repo.savePredefined(host.id, trip.id, {
      ...empty,
      startLocation: "Chapel Hill, NC",
      dietaryRestrictions: [],
    });
    expect((await repo.getPredefined(host.id)).startLocation).toBe("Chapel Hill, NC");

    const optA = newId("opt");
    const optB = newId("opt");
    const [poll] = await repo.createPolls([
      {
        tripId: trip.id,
        kind: "dates",
        question: "When?",
        status: "open",
        round: 1,
        options: [
          { id: optA, label: "Oct 17–18", value: { kind: "dates", startDate: "2026-10-17", endDate: "2026-10-18" } },
          { id: optB, label: "Either works", value: { kind: "abstain" } },
        ],
      },
    ]);
    if (!poll) throw new Error("no poll");
    await repo.castVote({ pollId: poll.id, memberId: host.id, optionId: optA, via: "number", rawText: "1" });
    await repo.castVote({ pollId: poll.id, memberId: host.id, optionId: optB, via: "number", rawText: "2" });
    const votes = await repo.listVotes(poll.id);
    expect(votes).toHaveLength(1);
    expect(votes[0]?.optionId).toBe(optB);

    const token = await repo.pollToken(poll.id, host.id);
    expect(await repo.pollToken(poll.id, host.id)).toBe(token);
    expect((await repo.resolvePollToken(token))?.member.id).toBe(host.id);
    expect(await repo.resolvePollToken("nope")).toBeNull();
  });
});
