import { describe, expect, it } from "vitest";
import {
  FallbackGeocoder,
  NominatimGeocoder,
  OsrmRouter,
  PhotonGeocoder,
  photonHitMatches,
  splitAtWaypoints,
} from "./geo";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("NominatimGeocoder", () => {
  it("sends an identifying User-Agent, parses the first hit and caches it", async () => {
    const calls: Array<{ url: string; ua: string | null }> = [];
    const fetchFn = (async (url: URL, init?: RequestInit) => {
      calls.push({ url: String(url), ua: new Headers(init?.headers).get("User-Agent") });
      return json([{ lat: "35.59", lon: "-82.55", display_name: "Asheville, NC" }]);
    }) as unknown as typeof fetch;
    const geo = new NominatimGeocoder("https://nominatim.example", "rta-test/1.0", fetchFn, 0);
    const hit = await geo.geocode("Asheville, NC");
    expect(hit).toEqual({ latLng: { lat: 35.59, lng: -82.55 }, displayName: "Asheville, NC" });
    await geo.geocode("asheville, nc ");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ua).toBe("rta-test/1.0");
    expect(calls[0]?.url).toContain("q=Asheville");
  });

  it("returns null on errors and empty results", async () => {
    const geo = new NominatimGeocoder(
      "https://n.example",
      "ua",
      (async () => json([], 200)) as unknown as typeof fetch,
      0,
    );
    expect(await geo.geocode("Nowhere")).toBeNull();
    const broken = new NominatimGeocoder(
      "https://n.example",
      "ua",
      (async () => json({}, 503)) as unknown as typeof fetch,
      0,
    );
    expect(await broken.geocode("Anywhere")).toBeNull();
  });
});

describe("OsrmRouter", () => {
  const points = [
    { id: "stop_a", latLng: { lat: 35.9, lng: -79.0 } },
    { id: "stop_b", latLng: { lat: 36.0, lng: -80.0 } },
    { id: "stop_c", latLng: { lat: 35.6, lng: -82.5 } },
  ];

  it("maps one multi-waypoint OSRM response to legs", async () => {
    const fetchFn = (async () =>
      json({
        code: "Ok",
        routes: [
          {
            geometry: {
              coordinates: [
                [-79.0, 35.9],
                [-79.5, 35.95],
                [-80.0, 36.0],
                [-81.0, 35.8],
                [-82.5, 35.6],
              ],
            },
            legs: [
              { distance: 95000.4, duration: 3700.6 },
              { distance: 240000, duration: 9000 },
            ],
          },
        ],
      })) as unknown as typeof fetch;
    const legs = await new OsrmRouter("https://osrm.example", "ua", fetchFn).route(points);
    expect(legs.map((l) => [l.fromStopId, l.toStopId, l.distanceMeters, l.durationSeconds, l.source])).toEqual([
      ["stop_a", "stop_b", 95000, 3701, "osrm"],
      ["stop_b", "stop_c", 240000, 9000, "osrm"],
    ]);
    expect(legs[0]?.geometry[0]).toEqual([35.9, -79.0]);
    expect(legs[1]?.geometry.at(-1)).toEqual([35.6, -82.5]);
  });

  it("falls back to labeled estimates when OSRM fails", async () => {
    const legs = await new OsrmRouter("https://osrm.example", "ua", (async () =>
      json({}, 500)) as unknown as typeof fetch).route(points);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.source === "estimate" && l.distanceMeters > 0)).toBe(true);
  });

  it("splits a polyline at waypoints", () => {
    const pieces = splitAtWaypoints(
      [
        [0, 0],
        [0, 1],
        [0, 2],
      ],
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 0, lng: 2 },
      ],
    );
    expect(pieces).toEqual([
      [
        [0, 0],
        [0, 1],
      ],
      [
        [0, 1],
        [0, 2],
      ],
    ]);
  });
});

describe("photonHitMatches", () => {
  it("accepts hits whose name and city match the query", () => {
    expect(
      photonHitMatches("Downtown Inn and Suites, Asheville, NC", {
        name: "Downtown Inn and Suites",
        city: "Asheville",
        countrycode: "US",
      }),
    ).toBe("match");
    expect(
      photonHitMatches("Chapel Hill, NC", { name: "Chapel Hill", state: "North Carolina", countrycode: "US" }),
    ).toBe("match");
    expect(
      photonHitMatches("78 Patton Ave, Asheville, NC", {
        street: "Patton Avenue",
        city: "Asheville",
        countrycode: "US",
      }),
    ).toBe("match");
    expect(
      photonHitMatches("2229 Lake James State Park Rd, Nebo, NC", {
        name: "Lake James State Park",
        street: "NC Hwy 126",
        city: "Nebo",
        countrycode: "US",
      }),
    ).toBe("match");
  });

  it("asks for a distance check when only the name matches (the hit has a county, not a city)", () => {
    expect(
      photonHitMatches("Blue Ridge Parkway Visitor Center, Asheville, NC", {
        name: "Blue Ridge Parkway Visitor Center",
        county: "Buncombe",
        countrycode: "US",
      }),
    ).toBe("check_distance");
  });

  it("rejects a different place, another house on the street, or another country", () => {
    expect(photonHitMatches("Sheetz, Morganton, NC", { name: "Morganton", countrycode: "US" })).toBe("no");
    expect(
      photonHitMatches("1208 W Wendover Ave, Greensboro, NC", {
        name: "W4, Greensboro Campus Center",
        housenumber: "3505",
        street: "East Wendover Avenue",
        city: "Greensboro",
        countrycode: "US",
      }),
    ).toBe("no");
    expect(photonHitMatches("Paris, TX", { name: "Paris", countrycode: "FR" })).toBe("no");
  });

  it("only accepts a same-name place in another city if it's near the stated city", async () => {
    const at = (lat: number, lng: number, props: Record<string, string>) => ({
      features: [{ geometry: { coordinates: [lng, lat] }, properties: { countrycode: "US", ...props } }],
    });
    const answers: Record<string, unknown> = {
      "Kapadokia Grill, Asheville, NC": at(36.07, -79.83, { name: "Kapadokia Grill", county: "Guilford" }),
      "Blue Ridge Parkway Visitor Center, Asheville, NC": at(35.566, -82.486, {
        name: "Blue Ridge Parkway Visitor Center",
        county: "Buncombe",
      }),
      "Asheville, NC": at(35.595, -82.551, { name: "Asheville" }),
    };
    const fetchFn = (async (url: URL) =>
      new Response(JSON.stringify(answers[url.searchParams.get("q") ?? ""] ?? { features: [] }))) as typeof fetch;
    const photon = new PhotonGeocoder("https://photon.test", "ua", fetchFn);
    expect(await photon.geocode("Kapadokia Grill, Asheville, NC")).toBeNull(); // ~250 km away
    expect(await photon.geocode("Blue Ridge Parkway Visitor Center, Asheville, NC")).not.toBeNull(); // ~6 km
  });
});

describe("FallbackGeocoder", () => {
  it("uses the next geocoder when the first misses", async () => {
    const hit = { latLng: { lat: 35, lng: -80 }, displayName: "x" };
    const g = new FallbackGeocoder({ geocode: async () => null }, { geocode: async () => hit });
    expect(await g.geocode("anything")).toBe(hit);
  });
});
