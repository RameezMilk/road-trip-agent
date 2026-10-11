import type { Member, Poll, Trip, TripPhase } from "../../schemas";
import { copy } from "../copy";
import type { Engine } from "../engine";
import { nextQuestion } from "./planning";

/**
 * Exponential-backoff reminders for members the trip is waiting on. All timing comes from the Tiger Data
 * hypertables (see `Repo.reminderState`): when the agent last spoke to them without an answer, how many
 * reminders already went out, and how long everyone who already answered has been waiting.
 */

/** First reminder 15 s after the unanswered message (short on purpose for the demo), then ×4: 1, 4, 16, 64 min. */
export const REMINDER_BASE_MS = 15_000;
export const REMINDER_FACTOR = 4;
export const REMINDER_MAX = 5;
/**
 * The window opens a little before the phase change: outbound timestamps come from the chat provider and
 * `phase_changed` from this process, so a slightly fast local clock mustn't hide the message that started
 * the phase.
 */
const WINDOW_GRACE_MS = 60_000;
/** Older unanswered messages are left alone, so a trip abandoned yesterday never pings anyone. */
const MAX_ANCHOR_AGE_MS = 2 * 60 * 60_000;

export const REMINDER_PHASES: TripPhase[] = ["onboarding", "planning", "voting", "review"];

interface OwedSteps {
  owing: Member[];
  done: Member[];
  phaseStart: Date;
  windowStart: Date;
  openPoll: Poll | null;
}

/** Who the trip is waiting on in its current phase (same rules as `status`). Null when nobody owes a step. */
async function owedSteps(e: Engine, trip: Trip): Promise<OwedSteps | null> {
  if (!REMINDER_PHASES.includes(trip.phase)) return null;
  const joined = await e.joinedMembers(trip.id);
  let owes: (m: Member) => boolean;
  let openPoll: Poll | null = null;

  switch (trip.phase) {
    case "onboarding":
      owes = (m) => m.name === null || !m.onboardingReady;
      break;
    case "planning":
      owes = (m) => !m.requirementsReady;
      break;
    case "voting":
    case "review": {
      openPoll = (await e.repo.listPolls(trip.id)).find((p) => p.status === "open") ?? null;
      if (openPoll) {
        const voted = new Set((await e.repo.listVotes(openPoll.id)).map((v) => v.memberId));
        owes = (m) => !voted.has(m.id);
      } else if (trip.phase === "review" && trip.currentVersion > 0) {
        const approved = new Set(await e.repo.listApprovals(trip.id, trip.currentVersion));
        owes = (m) => !approved.has(m.id);
      } else {
        return null; // between polls: the agent is working, not waiting on anyone
      }
      break;
    }
    default:
      return null;
  }

  const owing = joined.filter(owes);
  if (!owing.length) return null;
  const phaseStart = (await e.repo.phaseStartedAt(trip.id, trip.phase)) ?? trip.createdAt;
  return {
    owing,
    done: joined.filter((m) => !owes(m)),
    phaseStart,
    windowStart: new Date(phaseStart.getTime() - WINDOW_GRACE_MS),
    openPoll,
  };
}

/** What to answer, appended to the reminder. */
async function askFor(e: Engine, trip: Trip, member: Member, openPoll: Poll | null): Promise<string> {
  if (openPoll) return copy.pollText(openPoll, openPoll.round > 1);
  switch (trip.phase) {
    case "onboarding":
      return member.name === null ? copy.askName() : copy.onboardingHint(member.role === "host");
    case "planning": {
      if (member.name === null) return copy.askName();
      return nextQuestion(await e.repo.getPredefined(member.id), member.role === "host") ?? copy.askWish();
    }
    default:
      return copy.reviewAsk();
  }
}

/** Sends every reminder that is due on this trip. Run through the trip's queue. */
export async function sweep(e: Engine, tripId: string): Promise<void> {
  const trip = await e.repo.getTrip(tripId);
  if (!trip) return;
  const steps = await owedSteps(e, trip);
  // Only when someone is actually waiting on them ("Rameez is waiting on you…"): a host alone in a new
  // trip, or a vote nobody has answered yet, isn't worth a nudge.
  if (!steps || steps.done.length === 0) return;
  const states = await e.repo.reminderState(trip.id, steps.windowStart);
  const now = e.clock();

  for (const member of steps.owing) {
    const state = states.get(member.id);
    if (!state?.anchorAt || state.reminderCount >= REMINDER_MAX) continue;
    if (now.getTime() - state.anchorAt.getTime() > MAX_ANCHOR_AGE_MS) continue;
    const from = state.lastReminderAt ?? state.anchorAt;
    if (now.getTime() < from.getTime() + REMINDER_BASE_MS * REMINDER_FACTOR ** state.reminderCount) continue;

    const waiting = steps.done.map((m) => ({
      name: e.displayName(m),
      waitedMs: now.getTime() - (states.get(m.id)?.lastInboundAt ?? steps.phaseStart).getTime(),
    }));
    const text = copy.reminder(member.name, waiting, await askFor(e, trip, member, steps.openPoll));
    if (!(await e.sendTo(e.recipient(member), text))) continue;
    const attempt = state.reminderCount + 1;
    await e.repo.recordTripEvent(trip.id, "reminder_sent", { memberId: member.id, attempt }, now);
    e.log("reminder_sent", { tripId: trip.id, memberId: member.id, attempt });
  }
}
