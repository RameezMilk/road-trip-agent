import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb } from "../db/memory";
import { Repo } from "../db/repo";
import { buildItinerary } from "../domain/schedule";
import { LEGS, PLACED, RESOLVED } from "../domain/test-fixtures";
import { TripDashboard } from "../schemas";
import { createHttpApp } from "./app";

let repo: Repo;
beforeEach(async () => {
  repo = new Repo(await createMemoryDb());
});

describe("HTTP", () => {
  it("serves a privacy-safe dashboard for a trip", async () => {
    const { trip, host } = await repo.createTrip({
      title: "Fall break",
      timeZone: "America/New_York",
      hostHandle: "+19195550001",
      hostChatId: null,
    });
    await repo.updateMember(host.id, { name: "Alex" });
    await repo.updateTrip(trip.id, { resolved: RESOLVED });
    await repo.saveItinerary(
      buildItinerary({
        tripId: trip.id,
        version: 1,
        title: "Blue Ridge",
        timeZone: "America/New_York",
        resolved: RESOLVED,
        stops: PLACED,
        legs: LEGS,
        dayDepartTimes: new Map([[1, "09:00"]]),
        memberCount: 1,
        vehicleMpg: 30,
        gasPriceUsdPerGallon: 3,
        rationale: null,
        droppedStops: [],
      }),
      null,
    );
    const app = createHttpApp({ repo, engine: null });

    const res = await app.request(`/api/trips/${trip.publicId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const dashboard = TripDashboard.parse(body);
    expect(dashboard.members).toEqual([{ name: "Alex", approved: false }]);
    expect(dashboard.itinerary?.stops).toHaveLength(PLACED.length);
    expect(JSON.stringify(body)).not.toContain("+1919");
    expect(JSON.stringify(body)).not.toContain(trip.id);

    const page = await app.request(`/trip/${trip.publicId}`);
    expect(await page.text()).toContain('<meta property="og:title" content="Blue Ridge">');
  });

  it("404s unknown trips and poll tokens", async () => {
    const app = createHttpApp({ repo, engine: null });
    expect((await app.request("/api/trips/nope")).status).toBe(404);
    expect((await app.request("/api/trips/AAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await app.request("/api/polls/AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });
});
