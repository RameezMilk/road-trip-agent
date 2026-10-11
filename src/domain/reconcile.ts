import type { NewPoll } from "../db/repo";
import {
  newId,
  type PollOption,
  type PollOptionValue,
  type PredefinedField,
  PredefinedField as PredefinedFieldEnum,
  type PredefinedRequirements,
  type ResolvedRequirements,
  type TripType,
} from "../schemas";
import { formatLocalDate } from "./time";

export type RouteValue = { startLocation: string; endLocation: string; tripType: TripType };
export type DatesValue = { startDate: string; endDate: string };

export type Agreement<T> = { kind: "agreed"; value: T } | { kind: "differs"; options: T[] };

export interface PredefinedReconciliation {
  route: Agreement<RouteValue>;
  dates: Agreement<DatesValue>;
  /** Lowest stated, so everyone can afford it (not voted). */
  budgetPerPersonUsd: number;
  /** Union of everyone's restrictions (not voted). */
  dietaryRestrictions: string[];
}

export function missingFields(reqs: PredefinedRequirements): PredefinedField[] {
  return PredefinedFieldEnum.options.filter((f) => reqs[f] === null);
}

export type CompleteRequirements = { [K in keyof PredefinedRequirements]: NonNullable<PredefinedRequirements[K]> };

export function isComplete(reqs: PredefinedRequirements): reqs is CompleteRequirements {
  return missingFields(reqs).length === 0;
}

/** "Chapel Hill, North Carolina, USA" and "chapel hill, nc" should compare equal-ish. */
export function placeKey(place: string): string {
  return place
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(usa|united states( of america)?|us)\b/g, " ")
    .replace(/\bnorth carolina\b/g, "nc")
    .replace(/\s+/g, " ")
    .trim();
}

function distinct<T>(values: T[], key: (v: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const v of values) if (!seen.has(key(v))) seen.set(key(v), v);
  return [...seen.values()];
}

function agreement<T>(values: T[], key: (v: T) => string): Agreement<T> {
  const options = distinct(values, key);
  const [first] = options;
  if (options.length === 1 && first !== undefined) return { kind: "agreed", value: first };
  return { kind: "differs", options };
}

const STATE_SUFFIX =
  / (al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)$/;

/**
 * "Wilmington" and "Wilmington, NC" in the same trip are one place: a name without a state takes the
 * stated variant when exactly one exists (two different states stay separate).
 */
export function unifyPlaces(places: string[]): (place: string) => string {
  const variants = new Map<string, Map<string, string>>(); // base → state → original
  for (const p of places) {
    const key = placeKey(p);
    const state = key.match(STATE_SUFFIX)?.[1];
    if (!state) continue;
    const base = key.replace(STATE_SUFFIX, "");
    const byState = variants.get(base) ?? new Map<string, string>();
    if (!byState.has(state)) byState.set(state, p);
    variants.set(base, byState);
  }
  return (p) => {
    const key = placeKey(p);
    if (STATE_SUFFIX.test(key)) return p;
    const byState = variants.get(key);
    return byState?.size === 1 ? ([...byState.values()][0] as string) : p;
  };
}

export const routeKey = (r: RouteValue) => `${placeKey(r.startLocation)}|${placeKey(r.endLocation)}|${r.tripType}`;
export const datesKey = (d: DatesValue) => `${d.startDate}|${d.endDate}`;

export function reconcilePredefined(input: CompleteRequirements[]): PredefinedReconciliation {
  if (input.length === 0) throw new Error("reconcilePredefined needs at least one member");
  const same = unifyPlaces(input.flatMap((r) => [r.startLocation, r.endLocation]));
  const all = input.map((r) => ({ ...r, startLocation: same(r.startLocation), endLocation: same(r.endLocation) }));
  const dietary = distinct(
    all.flatMap((r) => r.dietaryRestrictions).filter((d) => !/^(none|no|n\/a)$/i.test(d.trim())),
    (d) => d.trim().toLowerCase(),
  );
  return {
    route: agreement(
      all.map((r) => ({ startLocation: r.startLocation, endLocation: r.endLocation, tripType: r.tripType })),
      routeKey,
    ),
    dates: agreement(
      all.map((r) => ({ startDate: r.startDate, endDate: r.endDate })),
      datesKey,
    ),
    budgetPerPersonUsd: Math.min(...all.map((r) => r.budgetPerPersonUsd)),
    dietaryRestrictions: dietary,
  };
}

export const tripTypeLabel = (t: TripType) => (t === "round_trip" ? "round trip" : "one way");
export const routeLabel = (r: RouteValue) => `${r.startLocation} → ${r.endLocation} (${tripTypeLabel(r.tripType)})`;
export const datesLabel = (d: DatesValue) =>
  d.startDate === d.endDate
    ? formatLocalDate(d.startDate)
    : `${formatLocalDate(d.startDate)} – ${formatLocalDate(d.endDate)}`;

export const ABSTAIN_LABEL = "Either works for me";

export function option(label: string, value: PollOptionValue): PollOption {
  return { id: newId("opt"), label, value };
}

export function withAbstain(options: PollOption[]): PollOption[] {
  return [...options, option(ABSTAIN_LABEL, { kind: "abstain" })];
}

/** Predefined polls, route first then dates, created queued (the voting phase opens one at a time). */
export function predefinedPolls(tripId: string, rec: PredefinedReconciliation): NewPoll[] {
  const polls: NewPoll[] = [];
  if (rec.route.kind === "differs") {
    polls.push({
      tripId,
      kind: "route",
      question: "Where are we going?",
      status: "queued",
      round: 1,
      options: withAbstain(rec.route.options.map((r) => option(routeLabel(r), { kind: "route", ...r }))),
    });
  }
  if (rec.dates.kind === "differs") {
    polls.push({
      tripId,
      kind: "dates",
      question: "When are we going?",
      status: "queued",
      round: 1,
      options: withAbstain(rec.dates.options.map((d) => option(datesLabel(d), { kind: "dates", ...d }))),
    });
  }
  return polls;
}

/**
 * Identity of a draft request: everything the planner reads except `decisions`, which only restate the
 * route/dates already in the key (optional-poll outcomes land in `adopted`). Used to match speculative drafts.
 */
export function draftKey(r: ResolvedRequirements): string {
  return JSON.stringify([
    r.startLocation,
    r.endLocation,
    r.tripType,
    r.startDate,
    r.endDate,
    r.budgetPerPersonUsd,
    [...r.dietaryRestrictions].map((d) => d.toLowerCase()).sort(),
    r.adopted.map((a) => `${a.category}:${a.text.toLowerCase()}`).sort(),
  ]);
}
