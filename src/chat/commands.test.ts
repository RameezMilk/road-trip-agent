import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands";
import { extractHandles, handleFromChatId, normalizeHandle } from "./phone";

describe("parseCommand", () => {
  it("parses bare keywords with or without a slash, any case, trailing punctuation", () => {
    for (const text of ["ready", "/ready", "READY!", " Ready. ", "ready 👍"]) {
      expect(parseCommand(text)).toEqual({ kind: "command", command: { name: "ready" } });
    }
    expect(parseCommand("approve")).toEqual({ kind: "command", command: { name: "approve" } });
    expect(parseCommand("status?")).toEqual({ kind: "command", command: { name: "status" } });
  });

  it("treats sentences that merely start with a keyword as natural language", () => {
    expect(parseCommand("ready to roll? I want halal food")).toBeNull();
    expect(parseCommand("help me find sushi")).toBeNull();
    expect(parseCommand("We took longer at this stop")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("12")).toBeNull();
  });

  it("parses newtrip with an optional title, including 'new trip'", () => {
    expect(parseCommand("newtrip")).toEqual({ kind: "command", command: { name: "newtrip", title: null } });
    expect(parseCommand("/newtrip Asheville weekend")).toEqual({
      kind: "command",
      command: { name: "newtrip", title: "Asheville weekend" },
    });
    expect(parseCommand("New trip: Fall break")).toEqual({
      kind: "command",
      command: { name: "newtrip", title: "Fall break" },
    });
  });

  it("extracts and normalises invitee handles", () => {
    expect(parseCommand("invite (919) 555-1234, +1 984 555 0000 and sam@iCloud.com")).toEqual({
      kind: "command",
      command: { name: "invite", handles: ["+19195551234", "+19845550000", "sam@icloud.com"] },
    });
    expect(parseCommand("invite my friends")).toMatchObject({ kind: "usage", name: "invite" });
  });

  it("parses join with or without a code", () => {
    expect(parseCommand("join")).toEqual({ kind: "command", command: { name: "join", code: null } });
    expect(parseCommand("join k7m-p2q")).toEqual({ kind: "command", command: { name: "join", code: "K7MP2Q" } });
    expect(parseCommand("join 0000000")).toMatchObject({ kind: "usage", name: "join" });
  });
});

describe("phone helpers", () => {
  it("normalises US numbers and rejects junk", () => {
    expect(normalizeHandle("919-555-1234")).toBe("+19195551234");
    expect(normalizeHandle("1 919 555 1234")).toBe("+19195551234");
    expect(normalizeHandle("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeHandle("12345")).toBeNull();
  });

  it("dedupes extracted handles", () => {
    expect(extractHandles("+19195551234 and 919-555-1234")).toEqual(["+19195551234"]);
  });

  it("reads the handle out of a DM chat id", () => {
    expect(handleFromChatId("any;-;+19195551234")).toBe("+19195551234");
    expect(handleFromChatId("any;+;chat123")).toBeNull();
  });
});
