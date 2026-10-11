import { helpText, parseCommand } from "../chat/commands";
import type { CardLayout, ChatPort, Recipient } from "../chat/port";
import type { Repo } from "../db/repo";
import type { ChatCommand, Itinerary, Member, Trip } from "../schemas";
import type { Llm } from "../services/llm";
import type { Planner } from "../services/planner";
import { copy } from "./copy";
import { KeyedQueue } from "./keyed-queue";
import * as execution from "./phases/execution";
import * as onboarding from "./phases/onboarding";
import * as planning from "./phases/planning";
import * as review from "./phases/review";
import * as status from "./phases/status";
import * as voting from "./phases/voting";

export type Log = (event: string, data?: Record<string, unknown>) => void;

export interface EngineConfig {
  publicBaseUrl: string | null;
  minMembers: number;
  timeZone: string;
  vehicleMpg: number;
  gasPriceUsdPerGallon: number;
}

export interface EngineDeps {
  repo: Repo;
  chat: ChatPort;
  llm: Llm;
  planner: Planner;
  config: EngineConfig;
  queue?: KeyedQueue;
  clock?: () => Date;
  log?: Log;
}

/** One inbound text from a member's DM, already deduped and recorded by the runtime. */
export interface Inbound {
  messageId: string;
  handle: string;
  chatId: string;
  text: string;
  receivedAt: Date;
}

export interface Ctx {
  msg: Inbound;
  trip: Trip;
  member: Member;
  command: ChatCommand | null;
}

/**
 * The trip state machine. Each member talks to it from their own DM; all shared state lives in the
 * database, so every handler re-reads what it needs. Callers must run `handle` through `queue` (keyed by
 * trip) — `runtime.ts` does — so a trip's state is only ever mutated by one handler at a time.
 */
export class Engine {
  readonly repo: Repo;
  readonly chat: ChatPort;
  readonly llm: Llm;
  readonly planner: Planner;
  readonly config: EngineConfig;
  readonly queue: KeyedQueue;
  readonly clock: () => Date;
  readonly log: Log;
  private readonly background = new Set<Promise<unknown>>();
  private readonly draftJobs = new Set<string>();

  constructor(deps: EngineDeps) {
    this.repo = deps.repo;
    this.chat = deps.chat;
    this.llm = deps.llm;
    this.planner = deps.planner;
    this.config = deps.config;
    this.queue = deps.queue ?? new KeyedQueue();
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** Queue key: the sender's trip, or their handle while they aren't in one. */
  async queueKey(handle: string): Promise<string> {
    const active = await this.repo.findActiveMembership(handle);
    return active ? active.trip.id : `handle:${handle}`;
  }

  /** Processes one message through the trip's queue. */
  async receive(msg: Inbound): Promise<void> {
    const key = await this.queueKey(msg.handle);
    await this.queue.run(key, () => this.handle(msg));
  }

  async handle(msg: Inbound): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (error) {
      this.log("engine_error", { error: String(error), stack: (error as Error)?.stack });
      await this.sendTo({ handle: msg.handle, chatId: msg.chatId, memberId: null, tripId: null }, copy.oops());
    }
  }

  private async dispatch(msg: Inbound): Promise<void> {
    const parsed = parseCommand(msg.text);
    const reply = async (text: string) => {
      await this.sendTo({ handle: msg.handle, chatId: msg.chatId, memberId: null, tripId: null }, text);
    };
    if (parsed?.kind === "usage") return reply(`Usage: ${parsed.usage}`);
    const command = parsed?.kind === "command" ? parsed.command : null;
    if (command?.name === "help") return reply(helpText());

    const active = await this.repo.findActiveMembership(msg.handle);
    if (!active) return onboarding.handleOutsider(this, msg, command);

    const ctx: Ctx = { msg, trip: active.trip, member: active.member, command };
    if (ctx.member.chatId !== msg.chatId) {
      await this.repo.updateMember(ctx.member.id, { chatId: msg.chatId });
      ctx.member = { ...ctx.member, chatId: msg.chatId };
    }

    switch (command?.name) {
      case "newtrip":
        return onboarding.newTripWhileActive(this, ctx, command.title);
      case "join":
        // A trip that's already on the road doesn't block joining the next one (same rule as `newtrip`).
        if (ctx.trip.phase === "execution") return onboarding.handleOutsider(this, msg, command);
        return this.reply(ctx, copy.alreadyInTrip(ctx.trip));
      case "status":
        return status.handle(this, ctx);
      case "cancel":
        return onboarding.cancel(this, ctx);
      case "dashboard":
        return execution.sendDashboard(this, ctx);
      default:
        break;
    }

    if (ctx.member.name === null && !command) return onboarding.captureName(this, ctx);

    switch (ctx.trip.phase) {
      case "onboarding":
        return onboarding.handle(this, ctx);
      case "planning":
        return planning.handle(this, ctx);
      case "voting":
        return voting.handle(this, ctx);
      case "drafting":
        return review.handleWhileDrafting(this, ctx);
      case "review":
        return review.handle(this, ctx);
      case "execution":
        return execution.handle(this, ctx);
      case "aborted":
        return this.reply(ctx, copy.tripAborted(ctx.trip));
    }
  }

  // --- messaging helpers --------------------------------------------------------------------------

  recipient(member: Member): Recipient {
    return { handle: member.handle, chatId: member.chatId, memberId: member.id, tripId: member.tripId };
  }

  /** Sends and swallows failures (logged), so one unreachable member can't break a broadcast. */
  async sendTo(to: Recipient, text: string): Promise<boolean> {
    try {
      await this.chat.sendText(to, text);
      return true;
    } catch (error) {
      this.log("send_failed", { to: to.memberId ?? "outsider", error: String(error) });
      return false;
    }
  }

  async reply(ctx: Ctx, text: string): Promise<void> {
    await this.sendTo(this.recipient(ctx.member), text);
  }

  async joinedMembers(tripId: string): Promise<Member[]> {
    return (await this.repo.listMembers(tripId)).filter((m) => m.status === "joined");
  }

  async broadcast(tripId: string, text: string, exceptMemberId?: string): Promise<void> {
    for (const m of await this.joinedMembers(tripId)) {
      if (m.id !== exceptMemberId) await this.sendTo(this.recipient(m), text);
    }
  }

  displayName(member: Member): string {
    return member.name ?? "A friend";
  }

  dashboardUrl(trip: Trip): string | null {
    return this.config.publicBaseUrl ? `${this.config.publicBaseUrl}/trip/${trip.publicId}` : null;
  }

  pollUrl(token: string): string | null {
    return this.config.publicBaseUrl ? `${this.config.publicBaseUrl}/poll/${token}` : null;
  }

  cardLayout(trip: Trip, itinerary: Itinerary | null): CardLayout {
    const title = itinerary?.title ?? trip.title;
    const route = itinerary ? `${itinerary.startLocation} → ${itinerary.endLocation}` : null;
    return {
      caption: `🚗 ${title}`,
      subcaption: route ? `${route} · v${itinerary?.version}` : "Trip dashboard",
      art: { title, subtitle: route ?? "Trip dashboard" },
    };
  }

  /** Sends the member's dashboard card, or edits it in place if one was sent before. */
  async upsertCard(trip: Trip, member: Member, itinerary: Itinerary | null, forceNew = false): Promise<void> {
    const url = this.dashboardUrl(trip);
    if (!url) return;
    const layout = this.cardLayout(trip, itinerary);
    const to = this.recipient(member);
    if (member.card && !forceNew) {
      try {
        const next = await this.chat.editCard(to, member.card, url, layout);
        if (next) await this.repo.updateMember(member.id, { card: next });
        return;
      } catch (error) {
        this.log("card_edit_failed", { member: member.id, error: String(error) });
      }
    }
    try {
      const card = await this.chat.sendCard(to, url, layout);
      if (card) await this.repo.updateMember(member.id, { card });
    } catch (error) {
      this.log("card_send_failed", { member: member.id, error: String(error) });
    }
  }

  async refreshCards(trip: Trip, itinerary: Itinerary): Promise<void> {
    for (const m of await this.joinedMembers(trip.id)) await this.upsertCard(trip, m, itinerary);
  }

  async currentItinerary(trip: Trip): Promise<Itinerary | null> {
    return trip.currentVersion > 0 ? this.repo.getItinerary(trip.id, trip.currentVersion) : null;
  }

  todayIn(timeZone: string): string {
    return this.clock().toLocaleDateString("en-CA", { timeZone });
  }

  // --- background work ----------------------------------------------------------------------------

  isDrafting(tripId: string): boolean {
    return this.draftJobs.has(tripId);
  }

  /**
   * Runs the (slow) itinerary draft outside the trip queue so other members still get replies, then
   * commits the result back through the queue.
   */
  startDraftJob(tripId: string, revision: review.Revision | null): void {
    if (this.draftJobs.has(tripId)) return;
    this.draftJobs.add(tripId);
    const job = (async () => {
      try {
        const itinerary = await review.draftItinerary(this, tripId, revision);
        this.draftJobs.delete(tripId);
        await this.queue.run(tripId, () => review.commitDraft(this, tripId, itinerary, revision));
      } catch (error) {
        this.draftJobs.delete(tripId);
        this.log("draft_failed", { tripId, error: String(error) });
        await this.queue.run(tripId, () => review.draftFailed(this, tripId, error));
      }
    })();
    this.track(job);
  }

  track(promise: Promise<unknown>): void {
    this.background.add(promise);
    void promise.finally(() => this.background.delete(promise));
  }

  /** Resolves when all background work (drafts) has finished — for tests and graceful shutdown. */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /** On boot: trips left in `drafting` by a restart get their draft restarted. */
  async resumeDrafting(): Promise<void> {
    for (const trip of await this.repo.listTripsInPhase("drafting")) this.startDraftJob(trip.id, null);
  }

  // --- poll widget (HTTP) ---------------------------------------------------------------------------

  async submitWidgetVote(token: string, choice: { optionId: string } | { otherText: string }) {
    const found = await this.repo.resolvePollToken(token);
    if (!found) return { ok: false as const, error: "unknown_poll" };
    return this.queue.run(found.trip.id, () => voting.castFromWidget(this, token, choice));
  }
}
