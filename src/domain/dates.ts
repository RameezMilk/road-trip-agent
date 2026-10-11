// Deterministic date-range parsing for the "📅 When?" answer. Handles abbreviations and misspelled
// months ("Octobr 18 to 19"), so the common answers don't need a (slow) Gemini call. Anything it can't
// read with confidence returns null and goes to Gemini (relative dates like "this weekend").

const MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
] as const;

/** Optimal string alignment distance (Levenshtein + adjacent transpositions: "Ocotber"). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number) => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, at(i - 2, j - 2) + 1);
      (d[i] as number[])[j] = v;
    }
  }
  return at(a.length, b.length);
}

/** "oct" → 10, "Octobr" → 10, "sept" → 9; null when unknown or ambiguous. */
export function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3 || !/^[a-z]+$/.test(w)) return null;
  let best: { month: number; distance: number } | null = null;
  let tie = false;
  MONTHS.forEach((names, index) => {
    for (const name of names) {
      // Prefixes of the full name ("octo", "septem") are exact.
      const distance = name.length > 3 && name.startsWith(w) ? 0 : editDistance(w, name);
      if (!best || distance < best.distance) {
        best = { month: index + 1, distance };
        tie = false;
      } else if (distance === best.distance && best.month !== index + 1) tie = true;
    }
  });
  const found = best as { month: number; distance: number } | null;
  if (!found || tie) return null;
  const allowed = w.length <= 4 ? 1 : 2;
  return found.distance <= allowed && (found.distance === 0 || w.length >= 4) ? found.month : null;
}

interface PartialDate {
  month: number | null;
  day: number;
  year: number | null;
}

const FILLER = new Set(["on", "the", "of", "from", "starting", "start", "leaving", "until", "til", "till"]);

/** One side of a range: "oct 18", "18 october", "18th", "10/18", "10/18/2026", "Oct 18, 2026". */
function parseSide(raw: string): PartialDate | null {
  const text = raw.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (slash) {
    const year = slash[3] ? Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]) : null;
    return { month: Number(slash[1]), day: Number(slash[2]), year };
  }
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  for (const token of text.split(" ").filter(Boolean)) {
    const t = token.toLowerCase();
    if (FILLER.has(t)) continue;
    const num = t.match(/^(\d{1,4})(?:st|nd|rd|th)?$/);
    if (num) {
      const n = Number(num[1]);
      if (num[1]?.length === 4 && year === null) year = n;
      else if (day === null && n >= 1 && n <= 31) day = n;
      else return null;
      continue;
    }
    const m = monthOf(t);
    if (m === null || month !== null) return null;
    month = m;
  }
  return day === null ? null : { month, day, year };
}

const pad = (n: number) => String(n).padStart(2, "0");

function toIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * "Oct 18 to Oct 25", "oct 18-25", "October 18 – Nov 2", "18-20 oct", "10/18-10/20", "Octobr 18 to 19",
 * or a single day (a day trip). Years default to the next occurrence on or after `today` (YYYY-MM-DD).
 */
export function parseDateRange(input: string, today: string): { startDate: string; endDate: string } | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[.!?]+$/, "")
    .replace(/^(?:from|on|leaving|we leave|i can do|i'?m free)\s+/, "");
  if (!text || text.length > 60) return null;
  const parts = text.split(/\s*(?:-|\bto\b|\buntil\b|\btill?\b|\bthrough\b|\bthru\b)\s*/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const first = parseSide(parts[0] as string);
  const second = parts[1] === undefined ? null : parseSide(parts[1]);
  if (!first || (parts[1] !== undefined && !second)) return null;

  // "18-20 oct": the month on the right applies to both sides; "oct 18-25": the left month carries over.
  const startMonth = first.month ?? second?.month ?? null;
  const endMonth = second ? (second.month ?? first.month) : startMonth;
  if (startMonth === null || endMonth === null) return null;

  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  let startYear = first.year ?? ty;
  if (first.year === null && (startMonth < tm || (startMonth === tm && first.day < td))) startYear += 1;
  const startDate = toIso(startYear, startMonth, first.day);
  if (!startDate) return null;
  if (!second) return { startDate, endDate: startDate };

  let endYear = second.year ?? startYear;
  let endDate = toIso(endYear, endMonth, second.day);
  if (endDate && endDate < startDate && second.year === null) {
    endYear += 1; // "Dec 30 - Jan 2"
    endDate = toIso(endYear, endMonth, second.day);
  }
  if (!endDate || endDate < startDate) return null;
  return { startDate, endDate };
}
