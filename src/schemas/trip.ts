import { z } from "zod";
import { FirstName, Handle, IanaTimeZone, InviteCode, MemberId, PublicId, TripId } from "./primitives";
import { ResolvedRequirements } from "./requirements";

/**
 * onboarding → planning → voting → drafting → review → execution
 * Any phase → aborted (host `cancel`, or a predefined poll that can't reach agreement).
 */
export const TripPhase = z.enum(["onboarding", "planning", "voting", "drafting", "review", "execution", "aborted"]);
export type TripPhase = z.infer<typeof TripPhase>;

export const MemberRole = z.enum(["host", "member"]);
export const MemberStatus = z.enum(["invited", "joined"]);

/** What `edit()` needs to update a live app card after a restart (Spectrum's `miniAppCardSession`). */
export const CardRef = z.strictObject({
  messageId: z.string().min(1),
  session: z.record(z.string(), z.unknown()),
});
export type CardRef = z.infer<typeof CardRef>;

export const Trip = z.strictObject({
  id: TripId,
  publicId: PublicId,
  inviteCode: InviteCode,
  title: z.string().min(1).max(80),
  phase: TripPhase,
  timeZone: IanaTimeZone,
  resolved: ResolvedRequirements.nullable(),
  currentVersion: z.int().min(0),
  abortReason: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Trip = z.infer<typeof Trip>;

export const Member = z.strictObject({
  id: MemberId,
  tripId: TripId,
  handle: Handle,
  chatId: z.string().nullable(),
  role: MemberRole,
  status: MemberStatus,
  name: FirstName.nullable(),
  onboardingReady: z.boolean(),
  requirementsReady: z.boolean(),
  card: CardRef.nullable(),
  joinedAt: z.date().nullable(),
});
export type Member = z.infer<typeof Member>;
