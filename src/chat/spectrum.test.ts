import type { Message, Space } from "spectrum-ts";
import { describe, expect, it } from "vitest";
import { toInbound } from "./spectrum";

const space = { id: "any;-;+19195550002", __platform: "imessage" } as unknown as Space;
const message = (content: unknown) =>
  ({
    id: "msg_1",
    content,
    sender: { id: "+19195550002" },
    timestamp: new Date("2026-10-11T10:08:38Z"),
  }) as unknown as Message;

describe("toInbound", () => {
  it("reads a photo sent with a caption (one grouped iMessage) as that photo plus its caption", async () => {
    const bytes = Buffer.from("jpeg");
    const ev = await toInbound(
      space,
      message({
        type: "group",
        items: [
          {
            content: {
              type: "attachment",
              name: "IMG_0024.JPG",
              mimeType: "image/jpeg",
              size: 4,
              read: async () => bytes,
            },
          },
          { content: { type: "text", text: "I want to go somewhere like this" } },
        ],
      }),
    );
    expect(ev.kind).toBe("attachment");
    expect(ev.text).toBe("I want to go somewhere like this");
    expect(ev.image?.mimeType).toBe("image/jpeg");
    expect(await ev.image?.read()).toBe(bytes);
    // Stored as what it was read as, so reminders count it as a reply and caption handling finds the photo.
    expect(ev.event.kind).toBe("attachment");
    expect(ev.event.content).toMatchObject({ type: "group", mimeType: "image/jpeg" });
  });

  it("reads a text-only group as text", async () => {
    const ev = await toInbound(
      space,
      message({
        type: "group",
        items: [{ content: { type: "text", text: "hi" } }, { content: { type: "text", text: "there" } }],
      }),
    );
    expect(ev.kind).toBe("text");
    expect(ev.text).toBe("hi\nthere");
  });
});
