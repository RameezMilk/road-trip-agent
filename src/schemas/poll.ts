import { z } from "zod";
import { LocalDate, MemberId, OptionId, PollId, RequirementId, TripId } from "./primitives";
import { Place, TripType } from "./requirements";

export const PollKind = z.enum(["route", "dates", "optional", "itinerary"]);
export type PollKind = z.infer<typeof PollKind>;

/** queued polls wait their turn: only one poll per trip is open at a time. */
export const PollStatus = z.enum(["queued", "open", "closed"]);

/** The structured value an option stands for, so a winning vote applies without re-parsing its label. */
export const PollOptionValue = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("route"), startLocation: Place, endLocation: Place, tripType: TripType }),
  z.strictObject({ kind: z.literal("dates"), startDate: LocalDate, endDate: LocalDate }),
  z.strictObject({
    kind: z.literal("optional"),
    requirementIds: z.array(RequirementId).max(20),
    resolution: z.string().min(1).max(200),
  }),
  z.strictObject({ kind: z.literal("itinerary"), instruction: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal("abstain") }),
]);
export type PollOptionValue = z.infer<typeof PollOptionValue>;

export const PollOption = z.strictObject({
  id: OptionId,
  label: z.string().min(1).max(160),
  value: PollOptionValue,
});
export type PollOption = z.infer<typeof PollOption>;

export const Poll = z.strictObject({
  id: PollId,
  tripId: TripId,
  kind: PollKind,
  question: z.string().min(1).max(200),
  options: z.array(PollOption).min(2).max(7),
  status: PollStatus,
  /** 1 = first vote, 2 = revote between tied options. */
  round: z.int().min(1).max(2),
  sequence: z.int().min(0),
  winningOptionId: OptionId.nullable(),
  createdAt: z.date(),
  closedAt: z.date().nullable(),
});
export type Poll = z.infer<typeof Poll>;

export const PollVoteVia = z.enum(["number", "other_text", "widget"]);
export type PollVoteVia = z.infer<typeof PollVoteVia>;

export const PollVote = z.strictObject({
  pollId: PollId,
  memberId: MemberId,
  optionId: OptionId,
  via: PollVoteVia,
  rawText: z.string().max(500).nullable(),
  castAt: z.date(),
});
export type PollVote = z.infer<typeof PollVote>;

/** What the poll widget page may see: its own poll and its own vote, nothing about other members. */
export const PollWidgetView = z.strictObject({
  question: z.string(),
  status: PollStatus,
  options: z.array(z.strictObject({ id: OptionId, label: z.string() })),
  myOptionId: OptionId.nullable(),
  votesCast: z.int().min(0),
  voters: z.int().min(0),
});
export type PollWidgetView = z.infer<typeof PollWidgetView>;

export const PollWidgetSubmission = z.union([
  z.strictObject({ optionId: OptionId }),
  z.strictObject({ otherText: z.string().trim().min(1).max(300) }),
]);
export type PollWidgetSubmission = z.infer<typeof PollWidgetSubmission>;
