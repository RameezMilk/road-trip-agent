import { z } from "zod";
import { Handle, InviteCode } from "./primitives";

/**
 * Every keyword the agent treats as a command. Anything else in a DM is natural language,
 * handled according to the trip phase. Keywords are accepted with or without a leading "/".
 */
export const ChatCommandName = z.enum([
  "newtrip",
  "invite",
  "join",
  "ready",
  "approve",
  "status",
  "dashboard",
  "help",
  "cancel",
]);
export type ChatCommandName = z.infer<typeof ChatCommandName>;

export const ChatCommand = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("newtrip"), title: z.string().trim().min(1).max(80).nullable() }),
  z.strictObject({ name: z.literal("invite"), handles: z.array(Handle).min(1).max(9) }),
  z.strictObject({ name: z.literal("join"), code: InviteCode.nullable() }),
  z.strictObject({ name: z.literal("ready") }),
  z.strictObject({ name: z.literal("approve") }),
  z.strictObject({ name: z.literal("status") }),
  z.strictObject({ name: z.literal("dashboard") }),
  z.strictObject({ name: z.literal("help") }),
  z.strictObject({ name: z.literal("cancel") }),
]);
export type ChatCommand = z.infer<typeof ChatCommand>;

export const COMMAND_USAGE: Record<ChatCommandName, string> = {
  newtrip: "newtrip [trip name] — start planning a new trip (you become the host)",
  invite: "invite +19195551234, +19195550000 — host only: invite friends by phone number or Apple ID email",
  join: "join [CODE] — accept a trip invite",
  ready: "ready — you're done with the current step",
  approve: "approve — approve the current itinerary",
  status: "status — where the trip stands",
  dashboard: "dashboard — resend the trip dashboard",
  help: "help — list commands",
  cancel: "cancel — host only: cancel the trip",
};
