import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  CardRef,
  type ChatEvent,
  EMPTY_PREDEFINED,
  Itinerary,
  type Member,
  newId,
  newInviteCode,
  newPollToken,
  newPublicId,
  type OptionalRequirement,
  type Poll,
  PollOption,
  type PollVote,
  type PredefinedRequirements,
  ResolvedRequirements,
  type Trip,
  type TripPhase,
} from "../schemas";
import type { Db } from "./client";
import * as t from "./schema";

type TripRow = typeof t.trips.$inferSelect;
type MemberRow = typeof t.members.$inferSelect;
type PollRow = typeof t.polls.$inferSelect;

function toTrip(row: TripRow): Trip {
  return {
    id: row.id,
    publicId: row.publicId,
    inviteCode: row.inviteCode,
    title: row.title,
    phase: row.phase,
    timeZone: row.timeZone,
    resolved: row.resolved ? ResolvedRequirements.parse(row.resolved) : null,
    currentVersion: row.currentVersion,
    abortReason: row.abortReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    tripId: row.tripId,
    handle: row.handle,
    chatId: row.chatId,
    role: row.role,
    status: row.status,
    name: row.name,
    onboardingReady: row.onboardingReady,
    requirementsReady: row.requirementsReady,
    card: row.card ? CardRef.parse(row.card) : null,
    joinedAt: row.joinedAt,
  };
}

function toPoll(row: PollRow): Poll {
  return {
    id: row.id,
    tripId: row.tripId,
    kind: row.kind,
    question: row.question,
    options: PollOption.array().parse(row.options),
    status: row.status,
    round: row.round,
    sequence: row.sequence,
    winningOptionId: row.winningOptionId,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}

export type NewPoll = Omit<Poll, "id" | "createdAt" | "closedAt" | "winningOptionId" | "sequence">;

/** All database access. Every jsonb document is re-validated with its Zod schema on the way out. */
export class Repo {
  constructor(readonly db: Db) {}

  // --- trips ------------------------------------------------------------------------------------

  async createTrip(input: { title: string; timeZone: string; hostHandle: string; hostChatId: string | null }) {
    return this.db.transaction(async (tx) => {
      const [trip] = await tx
        .insert(t.trips)
        .values({
          id: newId("trip"),
          publicId: newPublicId(),
          inviteCode: newInviteCode(),
          title: input.title,
          phase: "onboarding",
          timeZone: input.timeZone,
        })
        .returning();
      if (!trip) throw new Error("trip insert returned nothing");
      const [host] = await tx
        .insert(t.members)
        .values({
          id: newId("mem"),
          tripId: trip.id,
          handle: input.hostHandle,
          chatId: input.hostChatId,
          role: "host",
          status: "joined",
          joinedAt: new Date(),
        })
        .returning();
      if (!host) throw new Error("member insert returned nothing");
      return { trip: toTrip(trip), host: toMember(host) };
    });
  }

  async getTrip(id: string): Promise<Trip | null> {
    const [row] = await this.db.select().from(t.trips).where(eq(t.trips.id, id));
    return row ? toTrip(row) : null;
  }

  async getTripByPublicId(publicId: string): Promise<Trip | null> {
    const [row] = await this.db.select().from(t.trips).where(eq(t.trips.publicId, publicId));
    return row ? toTrip(row) : null;
  }

  async getTripByInviteCode(code: string): Promise<Trip | null> {
    const [row] = await this.db.select().from(t.trips).where(eq(t.trips.inviteCode, code));
    return row ? toTrip(row) : null;
  }

  async listTripsInPhase(phase: TripPhase): Promise<Trip[]> {
    const rows = await this.db.select().from(t.trips).where(eq(t.trips.phase, phase));
    return rows.map(toTrip);
  }

  /** Compare-and-set phase change: only succeeds if the trip is still in one of `from`. */
  async transition(tripId: string, from: TripPhase | TripPhase[], to: TripPhase): Promise<boolean> {
    const fromList = Array.isArray(from) ? from : [from];
    const rows = await this.db
      .update(t.trips)
      .set({ phase: to, updatedAt: new Date() })
      .where(and(eq(t.trips.id, tripId), inArray(t.trips.phase, fromList)))
      .returning({ id: t.trips.id });
    if (rows.length) await this.recordTripEvent(tripId, "phase_changed", { from: fromList, to });
    return rows.length > 0;
  }

  async updateTrip(
    tripId: string,
    patch: Partial<Pick<Trip, "resolved" | "currentVersion" | "abortReason" | "title">>,
  ): Promise<void> {
    const values: Partial<typeof t.trips.$inferInsert> = { updatedAt: new Date() };
    if (patch.resolved !== undefined)
      values.resolved = patch.resolved ? ResolvedRequirements.parse(patch.resolved) : null;
    if (patch.currentVersion !== undefined) values.currentVersion = patch.currentVersion;
    if (patch.abortReason !== undefined) values.abortReason = patch.abortReason;
    if (patch.title !== undefined) values.title = patch.title;
    await this.db.update(t.trips).set(values).where(eq(t.trips.id, tripId));
  }

  async touchTrip(tripId: string): Promise<void> {
    await this.db.update(t.trips).set({ updatedAt: new Date() }).where(eq(t.trips.id, tripId));
  }

  // --- members ----------------------------------------------------------------------------------

  /** The handle's current trip: newest joined membership whose trip isn't aborted. */
  async findActiveMembership(handle: string): Promise<{ trip: Trip; member: Member } | null> {
    const rows = await this.db
      .select({ trip: t.trips, member: t.members })
      .from(t.members)
      .innerJoin(t.trips, eq(t.members.tripId, t.trips.id))
      .where(and(eq(t.members.handle, handle), eq(t.members.status, "joined"), ne(t.trips.phase, "aborted")))
      .orderBy(desc(t.members.joinedAt))
      .limit(1);
    const row = rows[0];
    return row ? { trip: toTrip(row.trip), member: toMember(row.member) } : null;
  }

  /** Invites still waiting for this handle, newest first (only trips still onboarding). */
  async findPendingInvites(handle: string): Promise<Array<{ trip: Trip; member: Member }>> {
    const rows = await this.db
      .select({ trip: t.trips, member: t.members })
      .from(t.members)
      .innerJoin(t.trips, eq(t.members.tripId, t.trips.id))
      .where(and(eq(t.members.handle, handle), eq(t.members.status, "invited"), eq(t.trips.phase, "onboarding")))
      .orderBy(desc(t.members.createdAt));
    return rows.map((r) => ({ trip: toTrip(r.trip), member: toMember(r.member) }));
  }

  async addInvite(tripId: string, handle: string): Promise<{ member: Member; created: boolean }> {
    const [existing] = await this.db
      .select()
      .from(t.members)
      .where(and(eq(t.members.tripId, tripId), eq(t.members.handle, handle)));
    if (existing) return { member: toMember(existing), created: false };
    const [row] = await this.db
      .insert(t.members)
      .values({ id: newId("mem"), tripId, handle, role: "member", status: "invited" })
      .returning();
    if (!row) throw new Error("invite insert returned nothing");
    return { member: toMember(row), created: true };
  }

  async removeMember(memberId: string): Promise<void> {
    await this.db.delete(t.members).where(and(eq(t.members.id, memberId), eq(t.members.status, "invited")));
  }

  async joinMember(memberId: string, chatId: string | null): Promise<Member> {
    const [row] = await this.db
      .update(t.members)
      .set({ status: "joined", joinedAt: new Date(), chatId })
      .where(eq(t.members.id, memberId))
      .returning();
    if (!row) throw new Error(`member ${memberId} not found`);
    return toMember(row);
  }

  async updateMember(
    memberId: string,
    patch: Partial<Pick<Member, "name" | "onboardingReady" | "requirementsReady" | "card" | "chatId">>,
  ): Promise<void> {
    const values: Partial<typeof t.members.$inferInsert> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.onboardingReady !== undefined) values.onboardingReady = patch.onboardingReady;
    if (patch.requirementsReady !== undefined) values.requirementsReady = patch.requirementsReady;
    if (patch.card !== undefined) values.card = patch.card ? CardRef.parse(patch.card) : null;
    if (patch.chatId !== undefined) values.chatId = patch.chatId;
    if (Object.keys(values).length === 0) return;
    await this.db.update(t.members).set(values).where(eq(t.members.id, memberId));
  }

  async getMember(memberId: string): Promise<Member | null> {
    const [row] = await this.db.select().from(t.members).where(eq(t.members.id, memberId));
    return row ? toMember(row) : null;
  }

  async listMembers(tripId: string): Promise<Member[]> {
    const rows = await this.db
      .select()
      .from(t.members)
      .where(eq(t.members.tripId, tripId))
      .orderBy(asc(t.members.createdAt), asc(t.members.id));
    return rows.map(toMember);
  }

  // --- requirements -----------------------------------------------------------------------------

  async getPredefined(memberId: string): Promise<PredefinedRequirements> {
    const [row] = await this.db
      .select()
      .from(t.predefinedRequirements)
      .where(eq(t.predefinedRequirements.memberId, memberId));
    if (!row) return { ...EMPTY_PREDEFINED };
    return {
      startLocation: row.startLocation,
      endLocation: row.endLocation,
      startDate: row.startDate,
      endDate: row.endDate,
      tripType: row.tripType,
      budgetPerPersonUsd: row.budgetPerPersonUsd,
      dietaryRestrictions: row.dietaryRestrictions,
    };
  }

  async savePredefined(memberId: string, tripId: string, reqs: PredefinedRequirements): Promise<void> {
    const values = { ...reqs, updatedAt: new Date() };
    await this.db
      .insert(t.predefinedRequirements)
      .values({ memberId, tripId, ...values })
      .onConflictDoUpdate({ target: t.predefinedRequirements.memberId, set: values });
  }

  async listPredefined(tripId: string): Promise<Map<string, PredefinedRequirements>> {
    const members = await this.listMembers(tripId);
    const out = new Map<string, PredefinedRequirements>();
    for (const m of members) if (m.status === "joined") out.set(m.id, await this.getPredefined(m.id));
    return out;
  }

  async addOptional(req: OptionalRequirement & { tripId: string; sourceEventId: string | null }): Promise<void> {
    await this.db.insert(t.optionalRequirements).values(req);
  }

  async listOptional(tripId: string): Promise<OptionalRequirement[]> {
    const rows = await this.db
      .select()
      .from(t.optionalRequirements)
      .where(eq(t.optionalRequirements.tripId, tripId))
      .orderBy(asc(t.optionalRequirements.createdAt));
    return rows.map((r) => ({
      id: r.id,
      memberId: r.memberId,
      category: r.category as OptionalRequirement["category"],
      text: r.text,
    }));
  }

  // --- polls ------------------------------------------------------------------------------------

  async createPolls(polls: NewPoll[]): Promise<Poll[]> {
    if (polls.length === 0) return [];
    const tripId = polls[0]?.tripId as string;
    const existing = await this.listPolls(tripId);
    let sequence = existing.reduce((max, p) => Math.max(max, p.sequence + 1), 0);
    const rows = await this.db
      .insert(t.polls)
      .values(
        polls.map((p) => ({
          ...p,
          id: newId("poll"),
          options: PollOption.array().parse(p.options),
          sequence: sequence++,
        })),
      )
      .returning();
    return rows.map(toPoll).sort((a, b) => a.sequence - b.sequence);
  }

  async getPoll(pollId: string): Promise<Poll | null> {
    const [row] = await this.db.select().from(t.polls).where(eq(t.polls.id, pollId));
    return row ? toPoll(row) : null;
  }

  async listPolls(tripId: string): Promise<Poll[]> {
    const rows = await this.db.select().from(t.polls).where(eq(t.polls.tripId, tripId)).orderBy(asc(t.polls.sequence));
    return rows.map(toPoll);
  }

  async updatePoll(
    pollId: string,
    patch: Partial<Pick<Poll, "status" | "winningOptionId" | "closedAt" | "options" | "round">>,
  ): Promise<void> {
    const values: Partial<typeof t.polls.$inferInsert> = { ...patch };
    if (patch.options) values.options = PollOption.array().parse(patch.options);
    await this.db.update(t.polls).set(values).where(eq(t.polls.id, pollId));
  }

  async castVote(vote: Omit<PollVote, "castAt">): Promise<void> {
    const values = { ...vote, castAt: new Date() };
    await this.db
      .insert(t.pollVotes)
      .values(values)
      .onConflictDoUpdate({ target: [t.pollVotes.pollId, t.pollVotes.memberId], set: values });
  }

  async clearVotes(pollId: string): Promise<void> {
    await this.db.delete(t.pollVotes).where(eq(t.pollVotes.pollId, pollId));
  }

  async listVotes(pollId: string): Promise<PollVote[]> {
    const rows = await this.db.select().from(t.pollVotes).where(eq(t.pollVotes.pollId, pollId));
    return rows.map((r) => ({ ...r }));
  }

  async pollToken(pollId: string, memberId: string): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(t.pollTokens)
      .where(and(eq(t.pollTokens.pollId, pollId), eq(t.pollTokens.memberId, memberId)));
    if (existing) return existing.token;
    const token = newPollToken();
    await this.db.insert(t.pollTokens).values({ token, pollId, memberId });
    return token;
  }

  async resolvePollToken(token: string): Promise<{ poll: Poll; member: Member; trip: Trip } | null> {
    const [row] = await this.db
      .select({ poll: t.polls, member: t.members, trip: t.trips })
      .from(t.pollTokens)
      .innerJoin(t.polls, eq(t.pollTokens.pollId, t.polls.id))
      .innerJoin(t.members, eq(t.pollTokens.memberId, t.members.id))
      .innerJoin(t.trips, eq(t.polls.tripId, t.trips.id))
      .where(eq(t.pollTokens.token, token));
    return row ? { poll: toPoll(row.poll), member: toMember(row.member), trip: toTrip(row.trip) } : null;
  }

  // --- itinerary --------------------------------------------------------------------------------

  async saveItinerary(itinerary: Itinerary, changeSummary: string | null): Promise<void> {
    const parsed = Itinerary.parse(itinerary);
    await this.db.transaction(async (tx) => {
      await tx.insert(t.itineraryVersions).values({
        tripId: parsed.tripId,
        version: parsed.version,
        itinerary: parsed,
        changeSummary,
      });
      await tx
        .update(t.trips)
        .set({ currentVersion: parsed.version, updatedAt: new Date() })
        .where(eq(t.trips.id, parsed.tripId));
    });
  }

  async getItinerary(tripId: string, version: number): Promise<Itinerary | null> {
    const [row] = await this.db
      .select()
      .from(t.itineraryVersions)
      .where(and(eq(t.itineraryVersions.tripId, tripId), eq(t.itineraryVersions.version, version)));
    return row ? Itinerary.parse(row.itinerary) : null;
  }

  async approve(tripId: string, version: number, memberId: string): Promise<void> {
    await this.db.insert(t.approvals).values({ tripId, version, memberId }).onConflictDoNothing();
  }

  async listApprovals(tripId: string, version: number): Promise<string[]> {
    const rows = await this.db
      .select({ memberId: t.approvals.memberId })
      .from(t.approvals)
      .where(and(eq(t.approvals.tripId, tripId), eq(t.approvals.version, version)));
    return rows.map((r) => r.memberId);
  }

  // --- events -----------------------------------------------------------------------------------

  /** Inserts a chat event; returns false when it was already stored (at-least-once redelivery). */
  async recordChatEvent(event: ChatEvent): Promise<boolean> {
    const rows = await this.db
      .insert(t.chatEvents)
      .values(event)
      .onConflictDoNothing()
      .returning({ eventId: t.chatEvents.eventId });
    return rows.length > 0;
  }

  async recordTripEvent(tripId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.insert(t.tripEvents).values({ eventId: newId("evt"), occurredAt: new Date(), tripId, type, payload });
  }

  /**
   * The member's recent text conversation with the agent, oldest first, excluding one event (the message
   * being handled). Gives follow-ups like "Gypsy Queen" the context of the agent's previous question.
   */
  async recentConversation(
    memberId: string,
    excludeEventId: string,
    limit = 6,
  ): Promise<Array<{ direction: "inbound" | "outbound"; text: string }>> {
    const rows = await this.db
      .select({ eventId: t.chatEvents.eventId, direction: t.chatEvents.direction, text: t.chatEvents.text })
      .from(t.chatEvents)
      .where(and(eq(t.chatEvents.memberId, memberId), eq(t.chatEvents.kind, "text")))
      .orderBy(desc(t.chatEvents.occurredAt))
      .limit(limit + 1);
    return rows
      .filter((r) => r.eventId !== excludeEventId && r.text)
      .slice(0, limit)
      .reverse()
      .map((r) => ({ direction: r.direction, text: (r.text as string).slice(0, 400) }));
  }

  async latestChatEvents(limit: number) {
    return this.db.select().from(t.chatEvents).orderBy(desc(t.chatEvents.occurredAt)).limit(limit);
  }
}
