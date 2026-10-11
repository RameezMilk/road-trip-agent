import type { Poll, PollVote } from "../schemas";

export type TallyOutcome =
  | { kind: "winner"; optionId: string; votes: number; voters: number }
  | { kind: "tie"; optionIds: string[]; votes: number; voters: number };

export function isAbstain(poll: Poll, optionId: string): boolean {
  return poll.options.find((o) => o.id === optionId)?.value.kind === "abstain";
}

export function voteCounts(poll: Poll, votes: PollVote[]): Map<string, number> {
  const counts = new Map<string, number>(poll.options.map((o) => [o.id, 0]));
  for (const v of votes) if (counts.has(v.optionId)) counts.set(v.optionId, (counts.get(v.optionId) ?? 0) + 1);
  return counts;
}

/**
 * Most votes among non-abstaining voters wins. If everyone abstains, the first real option wins
 * (everyone said either works). Equal top counts are a tie for the caller to resolve.
 */
export function tally(poll: Poll, votes: PollVote[]): TallyOutcome {
  const counts = voteCounts(poll, votes);
  const real = poll.options.filter((o) => o.value.kind !== "abstain");
  const voters = votes.length;
  const max = Math.max(0, ...real.map((o) => counts.get(o.id) ?? 0));
  const first = real[0];
  if (!first) throw new Error(`poll ${poll.id} has no real options`);
  if (max === 0) return { kind: "winner", optionId: first.id, votes: 0, voters };
  const top = real.filter((o) => (counts.get(o.id) ?? 0) === max).map((o) => o.id);
  const [only] = top;
  if (top.length === 1 && only) return { kind: "winner", optionId: only, votes: max, voters };
  return { kind: "tie", optionIds: top, votes: max, voters };
}

/** Deterministic tiebreak for optional/itinerary polls: more supporting requirements, then listed first. */
/** The "keep the current plan" option of an itinerary poll (code adds it; a tie keeps the status quo). */
export const KEEP_CURRENT = "Keep the current itinerary unchanged.";

export function tiebreak(poll: Poll, optionIds: string[]): string {
  const keep = poll.options.find(
    (o) => optionIds.includes(o.id) && o.value.kind === "itinerary" && o.value.instruction === KEEP_CURRENT,
  );
  if (keep) return keep.id;
  const support = (id: string) => {
    const value = poll.options.find((o) => o.id === id)?.value;
    return value?.kind === "optional" ? value.requirementIds.length : 0;
  };
  const ordered = poll.options.filter((o) => optionIds.includes(o.id));
  ordered.sort((a, b) => support(b.id) - support(a.id));
  const winner = ordered[0];
  if (!winner) throw new Error("tiebreak over no options");
  return winner.id;
}
