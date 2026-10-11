import { diffItineraries, formatDiff } from "../../domain/diff";
import { option, withAbstain } from "../../domain/reconcile";
import { FeedbackAssessment, type Itinerary, type Poll, type PollOption, type TripPhase } from "../../schemas";
import { conversationBlock, itineraryBlock, requirementsBlock, SYSTEM } from "../../services/prompts";
import { copy, formatItinerary } from "../copy";
import type { Ctx, Engine } from "../engine";
import { begin as beginExecution } from "./execution";
import { castFromText, sendPoll } from "./voting";

/** A requested change to the current itinerary. */
export interface Revision {
  instruction: string;
  /** Minor changes keep everyone's approvals. */
  carryApprovals: boolean;
  note: string | null;
}

export const KEEP_CURRENT = "Keep the current itinerary unchanged.";

export async function startDrafting(
  e: Engine,
  tripId: string,
  from: TripPhase[],
  revision: Revision | null,
): Promise<void> {
  if (!(await e.repo.transition(tripId, from, "drafting"))) return;
  await e.broadcast(tripId, copy.drafting(revision !== null));
  for (const m of await e.joinedMembers(tripId)) await e.typing(e.recipient(m));
  e.startDraftJob(tripId, revision);
}

export async function draftItinerary(e: Engine, tripId: string, revision: Revision | null): Promise<Itinerary> {
  const trip = await e.repo.getTrip(tripId);
  if (!trip?.resolved) throw new Error("trip has no resolved requirements");
  const previous = await e.currentItinerary(trip);
  const members = await e.joinedMembers(tripId);
  const input = {
    tripId,
    version: trip.currentVersion + 1,
    title: trip.title,
    timeZone: trip.timeZone,
    resolved: trip.resolved,
    memberCount: members.length,
    ...(previous && revision ? { revision: { previous, instruction: revision.instruction } } : {}),
  };
  // First draft: research for the winning poll outcome usually started while people voted.
  const speculative = !previous && !revision ? e.takeSpeculation(tripId, trip.resolved) : null;
  if (speculative) {
    const research = await speculative.catch((error) => {
      e.log("draft_speculation_failed", { tripId, error: String(error) });
      return null;
    });
    if (research) return e.planner.place(input, research);
  }
  return e.planner.draft(input);
}

export async function commitDraft(
  e: Engine,
  tripId: string,
  draft: Itinerary,
  revision: Revision | null,
): Promise<void> {
  const trip = await e.repo.getTrip(tripId);
  if (trip?.phase !== "drafting") return; // cancelled meanwhile
  const previous = await e.currentItinerary(trip);
  const itinerary = { ...draft, version: trip.currentVersion + 1 };
  const diff = previous ? formatDiff(diffItineraries(previous, itinerary)) : null;
  await e.repo.saveItinerary(itinerary, diff);
  if (previous && revision?.carryApprovals) {
    for (const memberId of await e.repo.listApprovals(tripId, previous.version)) {
      await e.repo.approve(tripId, itinerary.version, memberId);
    }
  }
  if (!(await e.repo.transition(tripId, "drafting", "review"))) return;
  const header = previous && diff ? `${copy.revisedHeader(itinerary.version, revision?.note ?? null, diff)}\n\n` : "";
  await e.broadcast(tripId, `${header}${formatItinerary(itinerary)}\n\n${copy.reviewAsk()}`);
  await checkAllApproved(e, tripId);
}

export async function draftFailed(e: Engine, tripId: string, error: unknown): Promise<void> {
  const trip = await e.repo.getTrip(tripId);
  if (trip?.phase !== "drafting") return;
  const reason = error instanceof Error ? error.message.replace(/^[a-z_]+: /, "") : "unknown error";
  if (trip.currentVersion > 0) {
    await e.repo.transition(tripId, "drafting", "review");
    await e.broadcast(tripId, copy.draftFailed(reason.slice(0, 160), true));
  } else {
    await e.broadcast(tripId, copy.draftFailed(reason.slice(0, 160), false));
  }
}

export async function handleWhileDrafting(e: Engine, ctx: Ctx): Promise<void> {
  if (e.isDrafting(ctx.trip.id)) return void (await e.reply(ctx, copy.stillDrafting()));
  await e.reply(ctx, copy.retryingDraft());
  e.startDraftJob(ctx.trip.id, null);
}

export async function handle(e: Engine, ctx: Ctx): Promise<void> {
  const open = (await e.repo.listPolls(ctx.trip.id)).find((p) => p.status === "open");
  if (open && !ctx.command) return castFromText(e, ctx, open);
  if (ctx.command?.name === "approve" || ctx.command?.name === "ready") return approve(e, ctx);
  if (ctx.command) return void (await e.reply(ctx, copy.reviewAsk()));
  await feedback(e, ctx);
}

async function approve(e: Engine, ctx: Ctx): Promise<void> {
  const version = ctx.trip.currentVersion;
  await e.repo.approve(ctx.trip.id, version, ctx.member.id);
  const members = await e.joinedMembers(ctx.trip.id);
  const approvals = new Set(await e.repo.listApprovals(ctx.trip.id, version));
  const count = members.filter((m) => approvals.has(m.id)).length;
  await e.reply(ctx, copy.approved(count, members.length));
  if (count < members.length) {
    await e.broadcast(
      ctx.trip.id,
      copy.someoneApproved(e.displayName(ctx.member), version, count, members.length),
      ctx.member.id,
    );
  }
  await checkAllApproved(e, ctx.trip.id);
}

export async function checkAllApproved(e: Engine, tripId: string): Promise<void> {
  const trip = await e.repo.getTrip(tripId);
  if (trip?.phase !== "review" || trip.currentVersion === 0) return;
  const approvals = new Set(await e.repo.listApprovals(tripId, trip.currentVersion));
  const members = await e.joinedMembers(tripId);
  if (members.every((m) => approvals.has(m.id))) await beginExecution(e, tripId);
}

/** Natural-language feedback: Gemini sorts it into auto-apply / re-approve / group-vote. */
async function feedback(e: Engine, ctx: Ctx): Promise<void> {
  const itinerary = await e.currentItinerary(ctx.trip);
  if (!itinerary || !ctx.trip.resolved) return;
  const history = await e.repo.recentConversation(ctx.member.id, ctx.msg.messageId).catch(() => []);
  let assessment: FeedbackAssessment;
  try {
    assessment = await e.llm.generate({
      task: "feedback_assessment",
      system: SYSTEM.feedbackAssessment,
      prompt: `${requirementsBlock(ctx.trip.resolved, e.planner.tripDays(ctx.trip.resolved))}\n\n${itineraryBlock(itinerary)}\n\n${conversationBlock(history)}Feedback: """${ctx.msg.text}"""`,
      schema: FeedbackAssessment,
    });
  } catch (error) {
    e.log("feedback_assessment_failed", { error: String(error) });
    assessment = {
      impact: "material",
      summary: ctx.msg.text.slice(0, 120),
      instruction: ctx.msg.text,
      pollQuestion: null,
      pollOptions: [],
    };
  }

  if (assessment.impact === "conflicting" && assessment.pollOptions.length >= 1) {
    await e.reply(ctx, copy.conflictAck(assessment.summary));
    const options: PollOption[] = withAbstain([
      ...assessment.pollOptions.map((o) =>
        option(o.label.slice(0, 160), { kind: "itinerary", instruction: o.instruction.slice(0, 500) }),
      ),
      option(`Keep the current plan (v${itinerary.version})`, { kind: "itinerary", instruction: KEEP_CURRENT }),
    ]);
    const [poll] = await e.repo.createPolls([
      {
        tripId: ctx.trip.id,
        kind: "itinerary",
        question: (assessment.pollQuestion ?? assessment.summary).slice(0, 200),
        status: "open",
        round: 1,
        options,
      },
    ]);
    if (poll) await sendPoll(e, poll, false);
    return;
  }

  const minor = assessment.impact === "minor";
  await e.reply(ctx, minor ? copy.minorAck() : copy.materialAck());
  await startDrafting(e, ctx.trip.id, ["review"], {
    instruction: assessment.instruction || ctx.msg.text,
    carryApprovals: minor,
    note: assessment.summary.slice(0, 120) || null,
  });
}

export async function applyItineraryDecision(e: Engine, tripId: string, poll: Poll, winner: PollOption): Promise<void> {
  if (winner.value.kind !== "itinerary" || winner.value.instruction === KEEP_CURRENT) {
    const trip = await e.repo.getTrip(tripId);
    if (trip) await e.broadcast(tripId, copy.keepCurrent(trip.currentVersion));
    return;
  }
  await startDrafting(e, tripId, ["review"], {
    instruction: winner.value.instruction,
    carryApprovals: false,
    note: poll.question,
  });
}
