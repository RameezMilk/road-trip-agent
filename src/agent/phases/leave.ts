import { copy } from "../copy";
import type { Ctx, Engine } from "../engine";
import { maybeBeginVoting } from "./planning";
import { checkAllApproved } from "./review";
import { recheckOpenPoll } from "./voting";

/**
 * A member leaves (`leave`): from then on nothing counts them — answers, votes, approvals, reminders — and
 * the trip carries on for the others: a vote that was only waiting on them closes, planning that was
 * waiting on them moves to the vote, an approval round they held up completes. The host can't leave
 * (`cancel` ends the trip for everyone).
 */
export async function leave(e: Engine, ctx: Ctx): Promise<void> {
  if (ctx.member.role === "host") return void (await e.reply(ctx, copy.hostCantLeave()));
  await e.repo.leaveTrip(ctx.trip.id, ctx.member.id);
  await e.repo.recordTripEvent(ctx.trip.id, "member_left", { memberId: ctx.member.id });
  await e.reply(ctx, copy.youLeft(ctx.trip));
  await e.broadcast(ctx.trip.id, copy.someoneLeft(e.displayName(ctx.member)));

  const trip = await e.repo.getTrip(ctx.trip.id);
  switch (trip?.phase) {
    case "planning":
      return maybeBeginVoting(e, trip.id);
    case "voting":
      await recheckOpenPoll(e, trip.id);
      return;
    case "review":
      if (!(await recheckOpenPoll(e, trip.id))) await checkAllApproved(e, trip.id);
      return;
    default:
      return;
  }
}
