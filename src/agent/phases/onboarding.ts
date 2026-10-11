import { isRecipientNotAllowed } from "../../chat/port";
import { type ChatCommand, FirstName, type Trip } from "../../schemas";
import { copy } from "../copy";
import type { Ctx, Engine, Inbound } from "../engine";
import { startPlanning } from "./planning";

const NAME_PREFIX = /^(?:hi|hey|hello)?[\s,!]*(?:i'?m|i am|my name is|my name's|it'?s|call me|this is|name'?s)\s+/i;

/** "I'm sam!" → "Sam". Deterministic: names are short and the LLM isn't needed. */
export function parseFirstName(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(NAME_PREFIX, "")
    .replace(/[^\p{L}\p{M}'\- ]/gu, " ")
    .trim();
  const [first] = cleaned.split(/\s+/);
  if (!first || first.length > 40) return null;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  return FirstName.safeParse(name).success ? name : null;
}

/** A sender who isn't in any active trip yet. */
export async function handleOutsider(e: Engine, msg: Inbound, command: ChatCommand | null): Promise<void> {
  const to = { handle: msg.handle, chatId: msg.chatId, memberId: null, tripId: null };
  if (command?.name === "newtrip") {
    const { trip, host } = await e.repo.createTrip({
      title: command.title ?? "Road trip",
      timeZone: e.config.timeZone,
      hostHandle: msg.handle,
      hostChatId: msg.chatId,
    });
    await e.repo.recordTripEvent(trip.id, "trip_created", { hostId: host.id });
    await e.sendTo(e.recipient(host), copy.tripCreated(trip));
    return;
  }

  if (command?.name === "join") {
    let target: { trip: Trip; memberId: string } | null = null;
    if (command.code) {
      const trip = await e.repo.getTripByInviteCode(command.code);
      if (trip?.phase !== "onboarding") {
        await e.sendTo(to, copy.badCode());
        return;
      }
      const { member } = await e.repo.addInvite(trip.id, msg.handle);
      target = { trip, memberId: member.id };
    } else {
      const [pending] = await e.repo.findPendingInvites(msg.handle);
      if (pending) target = { trip: pending.trip, memberId: pending.member.id };
    }
    if (!target) {
      await e.sendTo(to, copy.noInvite());
      return;
    }
    const member = await e.repo.joinMember(target.memberId, msg.chatId);
    await e.repo.recordTripEvent(target.trip.id, "member_joined", { memberId: member.id });
    await e.sendTo(e.recipient(member), copy.joined(target.trip));
    return;
  }

  const [pending] = await e.repo.findPendingInvites(msg.handle);
  if (pending) {
    const host = (await e.repo.listMembers(pending.trip.id)).find((m) => m.role === "host");
    await e.sendTo(to, copy.pendingInvite(pending.trip, host ? e.displayName(host) : "A friend"));
    return;
  }
  await e.sendTo(to, copy.welcome());
}

export async function captureName(e: Engine, ctx: Ctx): Promise<void> {
  const name = parseFirstName(ctx.msg.text);
  if (!name) {
    await e.reply(ctx, copy.badName());
    return;
  }
  await e.repo.updateMember(ctx.member.id, { name });
  const member = { ...ctx.member, name };
  if (ctx.trip.phase !== "onboarding") {
    await e.reply(ctx, `Thanks, ${name}!`);
    return;
  }
  if (member.role === "host") {
    await e.reply(ctx, copy.hostNext(name, ctx.trip));
    return;
  }
  await e.reply(ctx, copy.memberNext(name));
  const all = await e.repo.listMembers(ctx.trip.id);
  const joined = all.filter((m) => m.status === "joined").length;
  await e.broadcast(ctx.trip.id, copy.someoneJoined(name, joined, all.length), member.id);
}

export async function handle(e: Engine, ctx: Ctx): Promise<void> {
  const { command } = ctx;
  if (command?.name === "invite") return invite(e, ctx, command.handles);
  if (command?.name === "ready") {
    if (!ctx.member.name) return void (await e.reply(ctx, copy.needName()));
    await e.repo.updateMember(ctx.member.id, { onboardingReady: true });
    return checkStart(e, ctx);
  }
  await e.reply(ctx, copy.onboardingHint(ctx.member.role === "host"));
}

async function invite(e: Engine, ctx: Ctx, handles: string[]): Promise<void> {
  if (ctx.member.role !== "host") return void (await e.reply(ctx, copy.hostOnly()));
  const sent: string[] = [];
  const failed: string[] = [];
  const already: string[] = [];
  for (const handle of handles) {
    if (handle === ctx.member.handle) continue;
    const { member, created } = await e.repo.addInvite(ctx.trip.id, handle);
    if (member.status === "joined") {
      already.push(handle);
      continue;
    }
    try {
      await e.chat.sendText(e.recipient(member), copy.invitation(e.displayName(ctx.member), ctx.trip));
      sent.push(handle);
    } catch (error) {
      e.log("invite_failed", { tripId: ctx.trip.id, error: String(error) });
      if (created || isRecipientNotAllowed(error)) await e.repo.removeMember(member.id);
      failed.push(handle);
    }
  }
  await e.reply(ctx, copy.inviteReport(sent, failed, already));
}

/** Planning starts once enough people joined, nobody invited is still pending, and everyone is ready. */
async function checkStart(e: Engine, ctx: Ctx): Promise<void> {
  const members = await e.repo.listMembers(ctx.trip.id);
  const joined = members.filter((m) => m.status === "joined");
  const waiting = [
    ...members.filter((m) => m.status === "invited").map((m) => copy.waitingOnInvite(m.handle)),
    ...joined.filter((m) => !m.onboardingReady && m.id !== ctx.member.id).map((m) => e.displayName(m)),
  ];
  if (joined.length < e.config.minMembers) waiting.push(copy.needMoreMembers(e.config.minMembers));
  if (waiting.length) {
    await e.reply(ctx, copy.waitingToStart(waiting));
    const ready = joined.filter((m) => m.onboardingReady || m.id === ctx.member.id).length;
    await e.broadcast(ctx.trip.id, copy.someoneReady(e.displayName(ctx.member), ready, members.length), ctx.member.id);
    return;
  }
  if (!(await e.repo.transition(ctx.trip.id, "onboarding", "planning"))) return;
  await startPlanning(e, ctx.trip.id);
}

export async function newTripWhileActive(e: Engine, ctx: Ctx, title: string | null): Promise<void> {
  if (ctx.trip.phase !== "execution") return void (await e.reply(ctx, copy.alreadyInTrip(ctx.trip)));
  await handleOutsider(e, ctx.msg, { name: "newtrip", title });
}

export async function cancel(e: Engine, ctx: Ctx): Promise<void> {
  if (ctx.member.role !== "host") return void (await e.reply(ctx, copy.hostOnly()));
  const from = ["onboarding", "planning", "voting", "drafting", "review", "execution"] as const;
  if (!(await e.repo.transition(ctx.trip.id, [...from], "aborted"))) return;
  await e.repo.updateTrip(ctx.trip.id, { abortReason: "cancelled by the host" });
  await e.broadcast(ctx.trip.id, copy.tripCancelled(ctx.trip));
}
