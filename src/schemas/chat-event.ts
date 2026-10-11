import { z } from "zod";
import { MemberId, TripId } from "./primitives";

export const ChatDirection = z.enum(["inbound", "outbound"]);

/** One row of the `chat_events` hypertable: every message in or out, per member. */
export const ChatEvent = z.strictObject({
  eventId: z.string().min(1),
  occurredAt: z.date(),
  chatId: z.string().min(1),
  tripId: TripId.nullable(),
  memberId: MemberId.nullable(),
  direction: ChatDirection,
  handle: z.string().nullable(),
  kind: z.string().min(1),
  text: z.string().nullable(),
  content: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
});
export type ChatEvent = z.infer<typeof ChatEvent>;
