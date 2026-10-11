import type { Repo } from "../db/repo";
import { type Trip, TripDashboard } from "../schemas";

/** The public dashboard view: first names and group aggregates only (see TripDashboard). */
export async function buildDashboard(repo: Repo, trip: Trip): Promise<TripDashboard> {
  const members = (await repo.listMembers(trip.id)).filter((m) => m.status === "joined");
  const itinerary = trip.currentVersion > 0 ? await repo.getItinerary(trip.id, trip.currentVersion) : null;
  const approvals = new Set(trip.currentVersion > 0 ? await repo.listApprovals(trip.id, trip.currentVersion) : []);
  let publicItinerary: TripDashboard["itinerary"] = null;
  if (itinerary) {
    const { tripId: _omit, ...rest } = itinerary;
    publicItinerary = rest;
  }
  return TripDashboard.parse({
    publicId: trip.publicId,
    title: itinerary?.title ?? trip.title,
    phase: trip.phase,
    members: members.map((m) => ({ name: m.name ?? "Traveler", approved: approvals.has(m.id) })),
    itinerary: publicItinerary,
    decisions: (trip.resolved?.decisions ?? []).map(({ pollId: _p, ...d }) => d),
    updatedAt: trip.updatedAt.toISOString(),
  });
}
