import type { Recipient } from "../../chat/port";
import {
  type CompleteRequirements,
  isComplete,
  option,
  predefinedPolls,
  reconcilePredefined,
  withAbstain,
} from "../../domain/reconcile";
import { isAbstain, tally, tiebreak } from "../../domain/tally";
import {
  conflictAnalysisSchema,
  type Poll,
  type PollVote,
  type PollVoteVia,
  type ResolvedRequirements,
  voteMappingSchema,
} from "../../schemas";
import { SYSTEM } from "../../services/prompts";
import { copy } from "../copy";
import type { Ctx, Engine } from "../engine";
import { applyItineraryDecision, startDrafting } from "./review";

/**
 * planning → voting: settle what everyone agrees on, then poll only where answers differ. While people
 * vote, Gemini already researches every possible outcome (Engine.speculate).
 */
export async function begin(e: Engine, tripId: string): Promise<void> {
  if (!(await e.repo.transition(tripId, "planning", "voting"))) return;
  const rec = reconcilePredefined(await completeRequirements(e, tripId));
  const fit = await wishesFit(e, tripId);
  const wishes = fit
    ? dedupeAdopted((await e.repo.listOptional(tripId)).map((w) => ({ category: w.category, text: w.text })))
    : [];
  const polls = await e.repo.createPolls(predefinedPolls(tripId, rec));
  await e.broadcast(
    tripId,
    copy.settled(
      rec,
      polls.length,
      wishes.map((w) => w.text),
    ),
  );

  const trip = await e.repo.getTrip(tripId);
  if (trip && polls.length && fit) {
    const routes = rec.route.kind === "agreed" ? [rec.route.value] : rec.route.options;
    const dates = rec.dates.kind === "agreed" ? [rec.dates.value] : rec.dates.options;
    const candidates = routes.flatMap((route) =>
      dates.map((d) => ({
        ...route,
        ...d,
        budgetPerPersonUsd: rec.budgetPerPersonUsd,
        dietaryRestrictions: rec.dietaryRestrictions,
        adopted: wishes,
        decisions: [],
      })),
    );
    e.speculate(trip, candidates, (await e.joinedMembers(tripId)).length);
  }
  await advance(e, tripId);
}

/**
 * Do all the group's wishes fit together? 0–1 wishes always do; otherwise OpenAI Decisions answers in one
 * fast call. false (or no Decider) means Gemini ConflictAnalysis decides, which can create polls.
 */
async function wishesFit(e: Engine, tripId: string): Promise<boolean> {
  const wishes = await e.repo.listOptional(tripId);
  if (wishes.length <= 1) return true;
  const key = `${tripId}:${wishes
    .map((w) => w.id)
    .sort()
    .join(",")}`;
  const cached = e.wishChecks.get(key);
  if (cached !== undefined) return cached;
  const probability = await e.decider.predicate({
    name: "wishes_compatible",
    instructions:
      "These are a road-trip group's wishes. Can ALL of them be satisfied together on one trip, with no wish competing with another for the same time, money or stop?",
    evidence: wishes.map((w, i) => `${i + 1}. ${w.text}`).join("\n"),
  });
  if (probability === null) return false;
  e.wishChecks.set(key, probability >= 0.5);
  return probability >= 0.5;
}

async function completeRequirements(e: Engine, tripId: string): Promise<CompleteRequirements[]> {
  const members = await e.joinedMembers(tripId);
  const all = await Promise.all(members.map((m) => e.repo.getPredefined(m.id)));
  return all.filter(isComplete);
}

/** Opens the next queued poll; when none are left, moves on (optional-requirement analysis, then drafting). */
export async function advance(e: Engine, tripId: string): Promise<void> {
  for (let guard = 0; guard < 10; guard++) {
    const trip = await e.repo.getTrip(tripId);
    if (trip?.phase !== "voting") return;
    const polls = await e.repo.listPolls(tripId);
    if (polls.some((p) => p.status === "open")) return;
    const queued = polls.find((p) => p.status === "queued");
    if (queued) {
      await e.repo.updatePoll(queued.id, { status: "open" });
      await sendPoll(e, { ...queued, status: "open" }, false);
      return;
    }
    if (!trip.resolved) {
      const resolved = await resolvePredefined(e, tripId, polls);
      await e.repo.updateTrip(tripId, { resolved });
      const created = await analyseOptional(e, tripId, resolved);
      if (created) continue;
    }
    await startDrafting(e, tripId, ["voting"], null);
    return;
  }
}

async function decisionOf(e: Engine, poll: Poll) {
  const votes = await e.repo.listVotes(poll.id);
  const winner = poll.options.find((o) => o.id === poll.winningOptionId);
  return {
    pollId: poll.id,
    question: poll.question,
    winningLabel: winner?.label ?? "",
    votes: votes.filter((v) => v.optionId === poll.winningOptionId).length,
    voters: votes.length,
  };
}

async function resolvePredefined(e: Engine, tripId: string, polls: Poll[]): Promise<ResolvedRequirements> {
  const rec = reconcilePredefined(await completeRequirements(e, tripId));
  const winnerValue = (kind: "route" | "dates") => {
    const poll = polls.find((p) => p.kind === kind && p.status === "closed");
    return poll?.options.find((o) => o.id === poll.winningOptionId)?.value;
  };
  const routeWin = winnerValue("route");
  const datesWin = winnerValue("dates");
  const route = rec.route.kind === "agreed" ? rec.route.value : routeWin?.kind === "route" ? routeWin : null;
  const dates = rec.dates.kind === "agreed" ? rec.dates.value : datesWin?.kind === "dates" ? datesWin : null;
  if (!route || !dates) throw new Error(`trip ${tripId}: predefined polls closed without a winner`);
  const decided = polls.filter((p) => (p.kind === "route" || p.kind === "dates") && p.status === "closed");
  return {
    startLocation: route.startLocation,
    endLocation: route.endLocation,
    tripType: route.tripType,
    startDate: dates.startDate,
    endDate: dates.endDate,
    budgetPerPersonUsd: rec.budgetPerPersonUsd,
    dietaryRestrictions: rec.dietaryRestrictions,
    adopted: [],
    decisions: await Promise.all(decided.map((p) => decisionOf(e, p))),
  };
}

/**
 * Gemini adopts the optional wishes that fit together and bundles real conflicts into ≤ 3 polls.
 * Returns true when it created polls. Wishes it forgot to mention are adopted (nothing is silently lost).
 */
async function analyseOptional(e: Engine, tripId: string, resolved: ResolvedRequirements): Promise<boolean> {
  const reqs = await e.repo.listOptional(tripId);
  if (reqs.length === 0) return false;
  if (await wishesFit(e, tripId)) {
    // Already announced with the settled requirements.
    const adopted = reqs.map((r) => ({ category: r.category, text: r.text }));
    await e.repo.updateTrip(tripId, {
      resolved: { ...resolved, adopted: dedupeAdopted([...resolved.adopted, ...adopted]) },
    });
    return false;
  }
  const ids = reqs.map((r) => r.id) as [string, ...string[]];
  let adoptedIds = new Set(ids);
  let pollsSpec: Array<{
    question: string;
    options: Array<{ label: string; requirementIds: string[]; resolution: string }>;
  }> = [];
  try {
    const out = await e.llm.generate({
      task: "conflict_analysis",
      system: SYSTEM.conflictAnalysis,
      prompt: `Settled: ${resolved.startLocation} → ${resolved.endLocation}, ${resolved.startDate}–${resolved.endDate}, $${resolved.budgetPerPersonUsd}/person, dietary: ${resolved.dietaryRestrictions.join(", ") || "none"}.\nOptional requirements:\n${reqs.map((r) => `[${r.id}] (${r.category}) ${r.text}`).join("\n")}`,
      schema: conflictAnalysisSchema(ids),
    });
    pollsSpec = out.polls.filter((p) => p.options.length >= 2);
    const inPolls = new Set(pollsSpec.flatMap((p) => p.options.flatMap((o) => o.requirementIds)));
    adoptedIds = new Set(ids.filter((id) => !inPolls.has(id)));
  } catch (error) {
    e.log("conflict_analysis_failed", { tripId, error: String(error) });
    await e.broadcast(tripId, copy.conflictCheckFailed());
  }

  const adopted = reqs.filter((r) => adoptedIds.has(r.id)).map((r) => ({ category: r.category, text: r.text }));
  await e.repo.updateTrip(tripId, {
    resolved: { ...resolved, adopted: dedupeAdopted([...resolved.adopted, ...adopted]) },
  });
  if (adopted.length) await e.broadcast(tripId, copy.optionalAdopted(adopted.length));
  if (pollsSpec.length === 0) return false;
  await e.repo.createPolls(
    pollsSpec.map((p) => ({
      tripId,
      kind: "optional" as const,
      question: p.question.slice(0, 200),
      status: "queued" as const,
      round: 1,
      options: withAbstain(
        p.options.map((o) =>
          option(o.label.slice(0, 160), {
            kind: "optional",
            requirementIds: o.requirementIds,
            resolution: o.resolution.slice(0, 200) || o.label.slice(0, 200),
          }),
        ),
      ),
    })),
  );
  return true;
}

function dedupeAdopted(items: ResolvedRequirements["adopted"]): ResolvedRequirements["adopted"] {
  const seen = new Set<string>();
  return items.filter((a) => {
    const k = a.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function sendPoll(e: Engine, poll: Poll, revote: boolean): Promise<void> {
  const text = copy.pollText(poll, revote);
  for (const m of await e.joinedMembers(poll.tripId)) {
    await e.sendTo(e.recipient(m), text);
    if (!e.config.pollWidget) continue; // votes are iMessage replies; the widget stays available
    const url = e.pollUrl(await e.repo.pollToken(poll.id, m.id));
    if (!url) continue;
    try {
      await e.chat.sendCard(e.recipient(m), url, { caption: `🗳️ ${poll.question}`, subcaption: "Tap to vote" });
    } catch (error) {
      e.log("poll_card_failed", { pollId: poll.id, error: String(error) });
    }
  }
}

async function openPoll(e: Engine, tripId: string): Promise<Poll | null> {
  return (await e.repo.listPolls(tripId)).find((p) => p.status === "open") ?? null;
}

export async function handle(e: Engine, ctx: Ctx): Promise<void> {
  const poll = await openPoll(e, ctx.trip.id);
  if (!poll) return void (await e.reply(ctx, copy.noOpenPoll()));
  if (ctx.command) return void (await e.reply(ctx, copy.pollText(poll, poll.round > 1)));
  await castFromText(e, ctx, poll);
}

/** A number picks that option; anything else is mapped by Gemini to the closest option (the "Other" path). */
export async function castFromText(e: Engine, ctx: Ctx, poll: Poll): Promise<void> {
  const text = ctx.msg.text.trim();
  const numeric = text.match(/^#?\s*(\d{1,2})\s*[.)!]?$/);
  let optionId: string | null = null;
  let via: PollVoteVia = "number";
  if (numeric) {
    optionId = poll.options[Number(numeric[1]) - 1]?.id ?? null;
  } else {
    via = "other_text";
    optionId = await mapToOption(e, poll, text, e.recipient(ctx.member));
  }
  if (!optionId) return void (await e.reply(ctx, copy.voteUnclear(poll.options.length)));
  await recordVote(e, poll, ctx.member.id, optionId, via, text);
}

const NO_OPTION = "none";

/** Free-text vote → option: OpenAI Decisions first (fast), Gemini if it's unavailable or unsure. */
async function mapToOption(e: Engine, poll: Poll, text: string, voter?: Recipient): Promise<string | null> {
  const decided = await e.decider.choose({
    name: "vote_mapping",
    instructions: `A traveler replied to the poll "${poll.question}". Which option does their reply choose?`,
    evidence: `Reply: ${text}`,
    choices: [
      ...poll.options.map((o, i) => ({ value: o.id, description: `${i + 1}. ${o.label}` })),
      { value: NO_OPTION, description: "The reply doesn't choose any of these options" },
    ],
  });
  if (decided && decided.confidence >= 0.5) return decided.value === NO_OPTION ? null : decided.value;
  const ids = poll.options.map((o) => o.id) as [string, ...string[]];
  if (voter) await e.typing(voter);
  try {
    const out = await e.llm.generate({
      task: "vote_mapping",
      system: SYSTEM.voteMapping,
      prompt: `Poll: ${poll.question}\nOptions:\n${poll.options.map((o) => `[${o.id}] ${o.label}`).join("\n")}\nVoter's reply: """${text}"""`,
      schema: voteMappingSchema(ids),
    });
    return out.optionId;
  } catch (error) {
    e.log("vote_mapping_failed", { error: String(error) });
    return null;
  }
}

async function recordVote(
  e: Engine,
  poll: Poll,
  memberId: string,
  optionId: string,
  via: PollVoteVia,
  rawText: string | null,
): Promise<string> {
  await e.repo.castVote({ pollId: poll.id, memberId, optionId, via, rawText: rawText?.slice(0, 500) ?? null });
  const members = await e.joinedMembers(poll.tripId);
  const votes = await e.repo.listVotes(poll.id);
  const member = members.find((m) => m.id === memberId);
  const label = poll.options.find((o) => o.id === optionId)?.label ?? "";
  const counted = copy.voteCounted(label, votes.length, members.length);
  if (member) await e.sendTo(e.recipient(member), counted);
  if (members.every((m) => votes.some((v) => v.memberId === m.id))) await closePoll(e, poll, votes);
  return label;
}

export async function castFromWidget(
  e: Engine,
  token: string,
  choice: { optionId: string } | { otherText: string },
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const found = await e.repo.resolvePollToken(token);
  if (!found) return { ok: false, error: "unknown_poll" };
  const { poll, member } = found;
  if (poll.status !== "open") return { ok: false, error: "poll_closed" };
  if (member.status !== "joined") return { ok: false, error: "not_a_member" };
  let optionId: string | null;
  let rawText: string | null = null;
  if ("optionId" in choice) {
    optionId = poll.options.some((o) => o.id === choice.optionId) ? choice.optionId : null;
  } else {
    rawText = choice.otherText;
    optionId = await mapToOption(e, poll, choice.otherText);
  }
  if (!optionId) return { ok: false, error: "no_matching_option" };
  const label = await recordVote(e, poll, member.id, optionId, "widget", rawText);
  return { ok: true, label };
}

/** Everyone has voted: pick the winner, revote once on a tie, abort if a must-have still can't be agreed. */
async function closePoll(e: Engine, poll: Poll, votes: PollVote[]): Promise<void> {
  const outcome = tally(poll, votes);
  let winnerId: string;
  if (outcome.kind === "tie") {
    if (poll.round === 1) {
      const tied = poll.options.filter((o) => outcome.optionIds.includes(o.id) || isAbstain(poll, o.id));
      await e.repo.clearVotes(poll.id);
      await e.repo.updatePoll(poll.id, { round: 2, options: tied });
      await sendPoll(e, { ...poll, round: 2, options: tied }, true);
      return;
    }
    if (poll.kind === "route" || poll.kind === "dates") {
      await e.repo.updatePoll(poll.id, { status: "closed", closedAt: new Date() });
      if (await e.repo.transition(poll.tripId, "voting", "aborted")) {
        await e.repo.updateTrip(poll.tripId, { abortReason: `no agreement on “${poll.question}”` });
        await e.broadcast(poll.tripId, copy.aborted(poll.question));
      }
      return;
    }
    winnerId = tiebreak(poll, outcome.optionIds);
  } else {
    winnerId = outcome.optionId;
  }

  const winner = poll.options.find((o) => o.id === winnerId);
  if (!winner) throw new Error(`poll ${poll.id}: winner ${winnerId} missing`);
  await e.repo.updatePoll(poll.id, { status: "closed", winningOptionId: winnerId, closedAt: new Date() });
  await e.repo.recordTripEvent(poll.tripId, "poll_closed", { pollId: poll.id, winnerId, round: poll.round });
  const votesForWinner = votes.filter((v) => v.optionId === winnerId).length;
  await e.broadcast(poll.tripId, copy.pollResult(poll.question, winner.label, votesForWinner, votes.length));

  if (poll.kind === "optional") {
    const trip = await e.repo.getTrip(poll.tripId);
    if (trip?.resolved && winner.value.kind === "optional") {
      await e.repo.updateTrip(trip.id, {
        resolved: {
          ...trip.resolved,
          adopted: dedupeAdopted([...trip.resolved.adopted, { category: "other", text: winner.value.resolution }]),
          decisions: [
            ...trip.resolved.decisions,
            {
              pollId: poll.id,
              question: poll.question,
              winningLabel: winner.label,
              votes: votesForWinner,
              voters: votes.length,
            },
          ],
        },
      });
    }
  }
  if (poll.kind === "itinerary") return applyItineraryDecision(e, poll.tripId, poll, winner);
  await advance(e, poll.tripId);
}
