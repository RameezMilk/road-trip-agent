/** `npm run trip:peek` — the latest trip's phase and current itinerary (stops, geocoding, totals). No handles. */
import { desc } from "drizzle-orm";
import { loadConfig, requireConfig } from "../config";
import { createDb } from "../db/client";
import { Repo } from "../db/repo";
import { trips } from "../db/schema";

const config = requireConfig(loadConfig(), "Tiger Data", ["DATABASE_URL"]);
const { db, close } = createDb(config.DATABASE_URL);
const repo = new Repo(db);
const [row] = await db.select().from(trips).orderBy(desc(trips.updatedAt)).limit(1);
if (!row) {
  console.log("no trips");
} else {
  const trip = await repo.getTrip(row.id);
  console.log(`trip ${row.title} · phase=${row.phase} · v${row.currentVersion} · dashboard=/trip/${row.publicId}`);
  const it = trip?.currentVersion ? await repo.getItinerary(trip.id, trip.currentVersion) : null;
  if (it) {
    for (const s of it.stops) {
      console.log(
        `  d${s.day} ${s.kind.padEnd(11)} ${s.name.slice(0, 40).padEnd(40)} ${s.geocodeSource} ${s.arriveAt?.slice(11, 16) ?? "-----"}→${s.departAt?.slice(11, 16) ?? "-----"}`,
      );
    }
    console.log(
      `  route=${it.routeSource} dropped=${JSON.stringify(it.droppedStops)} totals=${JSON.stringify(it.totals)}`,
    );
  }
}
await close();
