import { describe, expect, it } from "vitest";
import { cleanFirstName, handleKey, PhotonUsers } from "./photon-users";

const users = (list: Array<{ firstName: string | null; phoneNumber: string; email?: string | null }>) =>
  new Response(
    JSON.stringify({
      succeed: true,
      data: { users: list.map((u) => ({ id: "u", type: "shared", email: null, ...u })), total: list.length },
    }),
  );

describe("PhotonUsers", () => {
  it("looks up first names by phone or email with Basic auth, caching the list", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      return users([
        { firstName: "rameez malik", phoneNumber: "+19195550001" },
        { firstName: "Glenny", phoneNumber: "+19195550002", email: "Glen@Example.com" },
        { firstName: null, phoneNumber: "+19195550003" },
      ]);
    }) as typeof fetch;
    const dir = new PhotonUsers("https://spectrum.test", "proj", "secret", fetchFn);
    expect(await dir.firstName("+19195550001")).toBe("Rameez");
    expect(await dir.firstName("glen@example.com")).toBe("Glenny");
    expect(await dir.firstName("+1 (919) 555-0002")).toBe("Glenny");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://spectrum.test/projects/proj/users/");
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from("proj:secret").toString("base64")}`);
    // No name on file → null (the agent asks), without another request inside the refresh window.
    expect(await dir.firstName("+19195550003")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when the API fails", async () => {
    const dir = new PhotonUsers(
      "https://s.test",
      "p",
      "s",
      (async () => new Response("no", { status: 401 })) as typeof fetch,
    );
    expect(await dir.firstName("+19195550001")).toBeNull();
  });

  it("normalizes handles and names", () => {
    expect(handleKey("+1 919-555-0001")).toBe("19195550001");
    expect(handleKey(" A@B.com ")).toBe("a@b.com");
    expect(cleanFirstName("  sam  smith")).toBe("Sam");
    expect(cleanFirstName("")).toBeNull();
    expect(cleanFirstName("1234")).toBeNull();
  });
});
