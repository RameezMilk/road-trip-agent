import { diffItineraries, formatDiff } from "../../domain/diff";
import { option, withAbstain } from "../../domain/reconcile";
import { KEEP_CURRENT } from "../../domain/tally";
import {
  FeedbackAssessment,
  type Itinerary,
  type Poll,
  type PollOption,
  type ResolvedRequirements,
  type TripPhase,
} from "../../schemas";
import { LlmError } from "../../services/llm";
import { conversationBlock, itineraryBlock, requirementsBlock, SYSTEM } from "../../services/prompts";
import { copy } from "../copy";
import type { Ctx, Engine } from "../engine";
import { begin as beginExecution, launch } from "./execution";
import { feedbackFor, interpretPhoto } from "./photo";
import { castFromText, sendPoll } from "./voting";

/** A requested change to the current itinerary. */
export interface Revision {
  instruction: string;
  /** Minor changes keep everyone's approvals. */
  carryApprovals: boolean;
  note: string | null;
  /** A change the group voted on while on the road: the new plan goes straight back to the road. */
  backToRoad?: boolean;
  /** New end date / destination from that vote; applied to the trip when the new plan is saved. */
  tripChange?: TripChange;
}

export type TripChange = { endDate: string | null; endLocation: string | null };

export function applyTripChange(resolved: ResolvedRequirements, change: TripChange | undefined): ResolvedRequirements {
  if (!change) return resolved;
  return {
    ...resolved,
    ...(change.endDate ? { endDate: change.endDate } : {}),
    ...(change.endLocation ? { endLocation: change.endLocation } : {}),
  };
}

export { KEEP_CURRENT };

export async function startDrafting(
  e: Engine,
  tripId: string,
  from: TripPhase[],
  revision: Revision | null,
): Promise<void> {
  if (!(await e.repo.transition(tripId, from, "drafting"))) return;
  await e.broadcast(tripId, copy.drafting(revision !== null));
  e.startDraftJob(tripId, revision);
  for (const m of await e.joinedMembers(tripId)) e.typing(e.recipient(m));
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
    resolved: applyTripChange(trip.resolved, revision?.tripChange),
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
  const current = { ...trip, currentVersion: itinerary.version };

  // A change voted on the road: the trip takes the new dates/destination and goes straight back on the road.
  if (revision?.backToRoad) {
    if (trip.resolved)
      await e.repo.updateTrip(tripId, { resolved: applyTripChange(trip.resolved, revision.tripChange) });
    if (!(await e.repo.transition(tripId, "drafting", "execution"))) return;
    await e.broadcast(tripId, copy.roadUpdated(itinerary.version, revision.note, diff ?? ""));
    await e.refreshCards(current, itinerary);
    return;
  }

  // Without the review step the first itinerary goes straight to the road.
  if (!previous && !e.config.reviewStep) {
    if (await e.repo.transition(tripId, "drafting", "execution")) await launch(e, current, itinerary);
    return;
  }
  if (!(await e.repo.transition(tripId, "drafting", "review"))) return;
  // The itinerary is never sent as text: the card shows it, and revisions get a short diff.
  if (previous && diff) {
    await e.broadcast(
      tripId,
      `${copy.revisedHeader(itinerary.version, revision?.note ?? null, diff)}\n${copy.reviewAsk()}`,
    );
    await e.refreshCards(current, itinerary);
  } else {
    await Promise.all(
      (await e.joinedMembers(tripId)).map(async (m) => {
        await e.sendTo(e.recipient(m), copy.itineraryReady());
        await e.upsertCard(current, m, itinerary, true);
        await e.sendTo(e.recipient(m), copy.reviewAsk());
      }),
    );
  }
  await checkAllApproved(e, tripId);
}

export async function draftFailed(
  e: Engine,
  tripId: string,
  error: unknown,
  revision: Revision | null = null,
): Promise<void> {
  const trip = await e.repo.getTrip(tripId);
  if (trip?.phase !== "drafting") return;
  const reason = error instanceof Error ? error.message.replace(/^[a-z_]+: /, "") : "unknown error";
  if (revision?.backToRoad) {
    // The trip keeps its current plan (and dates/destination) and carries on.
    await e.repo.transition(tripId, "drafting", "execution");
    await e.broadcast(tripId, copy.roadChangeFailed(reason.slice(0, 160), trip.currentVersion));
    return;
  }
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
async function feedback(e: Engine, ctx: Ctx, text = ctx.msg.text): Promise<void> {
  const itinerary = await e.currentItinerary(ctx.trip);
  if (!itinerary || !ctx.trip.resolved) return;
  const history = await e.repo.recentConversation(ctx.member.id, ctx.msg.messageId).catch(() => []);
  let assessment: FeedbackAssessment;
  try {
    assessment = await e.llm.generate({
      task: "feedback_assessment",
      system: SYSTEM.feedbackAssessment,
      prompt: `${requirementsBlock(ctx.trip.resolved, e.planner.tripDays(ctx.trip.resolved))}\n\n${itineraryBlock(itinerary)}\n\n${conversationBlock(history)}Feedback: """${text}"""`,
      schema: FeedbackAssessment,
    });
  } catch (error) {
    e.log("feedback_assessment_failed", { error: String(error) });
    assessment = {
      impact: "material",
      summary: text.slice(0, 120),
      instruction: text,
      pollQuestion: null,
      pollOptions: [],
      awaitingPhoto: false,
    };
  }
  if (assessment.awaitingPhoto) return void (await e.reply(ctx, copy.sendThePhoto()));

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
    instruction: assessment.instruction || text,
    carryApprovals: minor,
    note: assessment.summary.slice(0, 120) || null,
  });
}

/** A photo during review: the place or kind of stop it shows becomes feedback on the itinerary. */
export async function photoFeedback(e: Engine, ctx: Ctx): Promise<void> {
  if (!ctx.trip.resolved) return;
  let reading: Awaited<ReturnType<typeof interpretPhoto>>;
  try {
    reading = await interpretPhoto(e, ctx, `${ctx.trip.resolved.startLocation} → ${ctx.trip.resolved.endLocation}`);
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    e.log("image_interpretation_failed", { error: String(error) });
    return void (await e.reply(ctx, copy.couldNot("I couldn't read that picture right now")));
  }
  const text = feedbackFor(reading.interpretation);
  if (!text) return void (await e.reply(ctx, copy.photoUnclear()));
  await e.reply(ctx, copy.photoSeen(reading.interpretation.description.trim().replace(/[.\s]+$/, "")));
  await feedback(e, ctx, text);
}

export async function applyItineraryDecision(e: Engine, tripId: string, poll: Poll, winner: PollOption): Promise<void> {
  // Review polls run in `review`; a change to the trip proposed on the road is voted on in `voting`.
  const trip = await e.repo.getTrip(tripId);
  const onTheRoad = trip?.phase === "voting";
  if (winner.value.kind !== "itinerary" || winner.value.instruction === KEEP_CURRENT) {
    if (trip) await e.broadcast(tripId, copy.keepCurrent(trip.currentVersion));
    if (onTheRoad) await e.repo.transition(tripId, "voting", "execution");
    return;
  }
  await startDrafting(e, tripId, onTheRoad ? ["voting"] : ["review"], {
    instruction: winner.value.instruction,
    carryApprovals: false,
    note: onTheRoad ? winner.label.replace(/^Yes — /, "") : poll.question,
    ...(onTheRoad ? { backToRoad: true } : {}),
    ...(winner.value.tripChange ? { tripChange: winner.value.tripChange } : {}),
  });
}
