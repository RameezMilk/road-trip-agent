import type { Message, Space } from "spectrum-ts";
import { describe, expect, it } from "vitest";
import { toChatEvent } from "./spectrum-adapter";

// Shapes mirror what the probe logged from the live Spectrum stream (Pro, shared line).
const space = { __platform: "imessage", id: "any;-;+15555550101", type: "dm", phone: "shared" } as unknown as Space;

function fakeMessage(overrides: Record<string, unknown>): Message {
  return {
    id: "spc-msg-1",
    platform: "imessage",
    direction: "inbound",
    sender: { __platform: "imessage", id: "+15555550101" },
    space,
    timestamp: new Date("2026-10-10T20:17:15.226Z"),
    reply: async () => undefined,
    dateDelivered: new Date("2026-10-10T20:17:15.500Z"),
    isDelivered: true,
    partIndex: 0,
    ...overrides,
  } as unknown as Message;
}

describe("toChatEvent", () => {
  it("maps an inbound text with provider metadata", async () => {
    const event = await toChatEvent(space, fakeMessage({ content: { type: "text", text: "/poll\u0000" } }), "stream");
    expect(event).toMatchObject({
      eventId: "spc-msg-1",
      chatId: "any;-;+15555550101",
      chatType: "dm",
      direction: "inbound",
      senderHandle: "+15555550101",
      kind: "text",
      text: "/poll",
      source: "stream",
    });
    expect(event.occurredAt.toISOString()).toBe("2026-10-10T20:17:15.226Z");
    expect(event.metadata).toEqual({ dateDelivered: "2026-10-10T20:17:15.500Z", isDelivered: true, partIndex: 0 });
  });

  it("keeps attachment metadata but never bytes", async () => {
    const content = {
      type: "attachment",
      id: "att1",
      name: "IMG.HEIC",
      mimeType: "image/heic",
      size: 2048,
      read: async () => Buffer.alloc(1),
    };
    const event = await toChatEvent(space, fakeMessage({ content }), "stream");
    expect(event.content).toEqual({ attachmentId: "att1", name: "IMG.HEIC", mimeType: "image/heic", size: 2048 });
    expect(JSON.stringify(event)).not.toContain("read");
  });

  it("records the agent's own sends without a sender handle", async () => {
    const content = { type: "app", url: async () => "https://example.test/probe?s=1", live: true };
    const event = await toChatEvent(space, fakeMessage({ direction: "outbound", content }), "send");
    expect(event).toMatchObject({ direction: "outbound", senderHandle: null, kind: "app", source: "send" });
    expect(event.content).toEqual({ url: "https://example.test/probe?s=1", live: true });
  });

  it("maps reactions and read receipts to their target message", async () => {
    const target = { id: "spc-msg-0" };
    const reaction = await toChatEvent(
      space,
      fakeMessage({ content: { type: "reaction", emoji: "👍", target } }),
      "stream",
    );
    expect(reaction).toMatchObject({ kind: "reaction", text: "👍", content: { targetId: "spc-msg-0" } });
    const read = await toChatEvent(space, fakeMessage({ id: "x:read:1", content: { type: "read", target } }), "stream");
    expect(read).toMatchObject({ kind: "read", text: null, content: { targetId: "spc-msg-0" } });
  });
});
