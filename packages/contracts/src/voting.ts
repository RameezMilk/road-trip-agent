import { z } from "zod";
import { VoteState } from "./enums";
import { CandidateId, EventId, IsoDateTime, ParticipantId, PlanVersion, TripId } from "./primitives";

export const Ballot = z.strictObject({
  tripId: TripId,
  planVersion: PlanVersion,
  candidateIds: z.array(CandidateId).min(1).max(8),
  participantIds: z.array(ParticipantId).min(1).max(10),
  openedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
});
export type Ballot = z.infer<typeof Ballot>;

/** One current state per (participant, candidate); later events replace earlier ones. */
export const Vote = z.strictObject({
  eventId: EventId,
  tripId: TripId,
  planVersion: PlanVersion,
  participantId: ParticipantId,
  candidateId: CandidateId,
  state: VoteState,
  castAt: IsoDateTime,
  source: z.enum(["miniapp_confirmed", "chat_command", "native_poll"]),
});
export type Vote = z.infer<typeof Vote>;
