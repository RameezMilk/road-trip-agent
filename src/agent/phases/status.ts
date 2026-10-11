import { missingFields } from "../../domain/reconcile";
import { currentStopIndex } from "../../domain/schedule";
import { formatTime } from "../../domain/time";
import { copy, STOP_ICONS } from "../copy";
import type { Ctx, Engine } from "../engine";

/** `status`: where the trip stands. Group-level only — never anyone's private answers or votes. */
export async function handle(e: Engine, ctx: Ctx): Promise<void> {
  const { trip } = ctx;
  const members = await e.repo.listMembers(trip.id);
  const joined = members.filter((m) => m.status === "joined");
  const lines = [`🚗 “${trip.title}” — ${trip.phase}`];

  switch (trip.phase) {
    case "onboarding":
      lines.push(
        ...joined.map(
          (m) => `${m.onboardingReady ? "✅" : "⏳"} ${e.displayName(m)}${m.role === "host" ? " (host)" : ""}`,
        ),
        ...members.filter((m) => m.status === "invited").map((m) => `✉️ ${copy.waitingOnInvite(m.handle)}`),
        `Trip code: ${trip.inviteCode}`,
      );
      break;
    case "planning": {
      lines.push(...joined.map((m) => `${m.requirementsReady ? "✅" : "⏳"} ${e.displayName(m)}`));
      const mine = missingFields(await e.repo.getPredefined(ctx.member.id));
      if (mine.length) lines.push("", copy.stillMissing(mine));
      break;
    }
    case "voting":
    case "review": {
      const open = (await e.repo.listPolls(trip.id)).find((p) => p.status === "open");
      if (open) {
        const votes = await e.repo.listVotes(open.id);
        lines.push(`🗳️ ${open.question} — ${votes.length}/${joined.length} votes in`);
      }
      if (trip.phase === "review") {
        const approvals = new Set(await e.repo.listApprovals(trip.id, trip.currentVersion));
        lines.push(
          `v${trip.currentVersion}: ${joined.filter((m) => approvals.has(m.id)).length}/${joined.length} approved`,
        );
        lines.push(...joined.map((m) => `${approvals.has(m.id) ? "✅" : "⏳"} ${e.displayName(m)}`));
      }
      break;
    }
    case "drafting":
      lines.push(copy.stillDrafting());
      break;
    case "execution": {
      const itinerary = await e.currentItinerary(trip);
      if (itinerary) {
        const i = currentStopIndex(itinerary, e.clock());
        const next = itinerary.stops[i + 1];
        if (next?.arriveAt) {
          lines.push(`Next: ${STOP_ICONS[next.kind]} ${next.name} at ${formatTime(next.arriveAt, itinerary.timeZone)}`);
        }
      }
      break;
    }
    case "aborted":
      lines.push(copy.tripAborted(trip));
      break;
  }
  await e.reply(ctx, lines.join("\n"));
}
