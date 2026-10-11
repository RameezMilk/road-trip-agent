import type { TripType } from "../schemas";

// Deterministic readers for the grouped planning questions. They cover the short answers people actually
// type, so most replies are instant; anything else returns null and goes to Gemini.

const STATES = new Set(
  "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc".split(
    " ",
  ),
);
const LOWER_WORDS = new Set(["of", "the", "on", "at", "and", "de", "la"]);

/** "chapel hill nc" → "Chapel Hill, NC"; "outer banks" → "Outer Banks". */
export function tidyPlace(raw: string): string {
  const words = raw
    .trim()
    .replace(/[.,]+$/g, "")
    .replace(/\s*,\s*/g, " , ")
    .split(/\s+/)
    .filter(Boolean);
  const last = words.at(-1)?.toLowerCase();
  const state = last && STATES.has(last) && words.length > 1 ? last.toUpperCase() : null;
  const body = (state ? words.slice(0, -1) : words).filter((w, i, all) => !(w === "," && i === all.length - 1));
  const titled = body
    .map((w, i) =>
      w === ","
        ? ","
        : i > 0 && LOWER_WORDS.has(w.toLowerCase())
          ? w.toLowerCase()
          : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ")
    .replace(/ ,/g, ",");
  return state ? `${titled}, ${state}` : titled;
}

const ONE_WAY = /\b(?:one[\s-]?way|1[\s-]?way|not coming back|no return)\b/i;
const ROUND_TRIP = /\b(?:round[\s-]?trip|rt|there and back|and back|return(?:ing)?(?: home)?|both ways)\b/i;
// Words that make a reply a sentence or small talk rather than a place name.
const SENTENCE =
  /\b(?:i|we|my|me|us|want|wanna|go|going|like|love|please|pls|would|could|let'?s|maybe|think|yes|yeah|no|nope|ok|okay|sure|idk|dunno|somewhere|anywhere|wherever|hi|hey|hello|thanks)\b/i;

/** "one way" / "round trip" on its own (no places), or null. */
export function parseTripType(input: string): TripType | null {
  const text = input
    .trim()
    .replace(/[.!]+$/, "")
    .replace(/^(?:it'?s|just|a)\s+/i, "");
  if (/^(?:one[\s-]?way|1[\s-]?way)$/i.test(text)) return "one_way";
  if (/^(?:round[\s-]?trip|there and back|both ways)$/i.test(text)) return "round_trip";
  return null;
}

/** A reply that is just a place ("Myrtle Beach", "asheville nc"), tidied; null for anything else. */
export function placeName(input: string): string | null {
  const text = input.trim().replace(/[.!]+$/, "");
  if (!/^[\p{L}][\p{L} .,'-]{1,58}$/u.test(text) || text.split(/\s+/).length > 5) return null;
  if (SENTENCE.test(text) || ONE_WAY.test(text) || ROUND_TRIP.test(text)) return null;
  if (/^(?:the\s+)?(?:beach|mountains?|lake|coast|city|countryside)$/i.test(text)) return null; // a vibe, not a place
  return tidyPlace(text);
}

/**
 * "Chapel Hill to Wilmington", "chapel hill → wilmington nc, one way", "Asheville from Durham".
 * tripType is null when not stated (the planner then defaults to round trip, as the question says).
 */
export function parseRoute(
  input: string,
): { startLocation: string; endLocation: string; tripType: TripType | null } | null {
  let text = input.trim().replace(/[!?]+$/, "");
  if (!text || text.length > 120) return null;
  const tripType: TripType | null = ONE_WAY.test(text) ? "one_way" : ROUND_TRIP.test(text) ? "round_trip" : null;
  text = text
    .replace(ONE_WAY, " ")
    .replace(ROUND_TRIP, " ")
    .replace(/[()]/g, " ")
    .replace(/[\s,;]+$/g, "")
    .replace(/^(?:from|going from|leaving from|start(?:ing)? (?:in|at|from))\s+/i, "")
    .trim();
  let start: string | undefined;
  let end: string | undefined;
  const reversed = text.match(/^(?:to\s+)?(.+?)\s+from\s+(.+)$/i);
  if (reversed) [, end, start] = reversed;
  else [start, end] = text.split(/\s*(?:→|->|=>|—>)\s*|\s+to\s+/i);
  if (!start || !end || text.split(/\s*(?:→|->|=>|—>)\s*|\s+to\s+/i).length > 2) return null;
  const clean = (s: string) => s.replace(/^[\s,;-]+|[\s,;-]+$/g, "");
  const [a, b] = [clean(start), clean(end)];
  // Place names, not sentences ("I want to go to Boone" → Gemini).
  const plausible = (s: string) =>
    s.length >= 2 && s.length <= 60 && s.split(/\s+/).length <= 5 && /[a-z]/i.test(s) && !SENTENCE.test(s);
  if (!plausible(a) || !plausible(b)) return null;
  return { startLocation: tidyPlace(a), endLocation: tidyPlace(b), tripType };
}

const NONE_DIET =
  /^(?:none|no|nope|nah|nothing|n\/a|na|no restrictions?|no dietary restrictions?|nothing special|i eat everything|anything|everything|all good)$/i;

/**
 * "$300, halal" / "250 none" / "300 vegetarian and nut allergy" / "halal, $300" / "300" / "halal".
 * Each field is undefined when not stated; null overall when the message is too complex.
 */
export function parseBudgetDiet(input: string): { budgetPerPersonUsd?: number; dietaryRestrictions?: string[] } | null {
  let text = ` ${input.trim().replace(/[.!]+$/, "")} `;
  if (text.length > 160) return null;
  const money =
    text.match(/\$\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks)?/i) ??
    text.match(/(?<![\w.])(\d{1,5}(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks)\b/i) ??
    text.match(/^\s*(\d{1,5}(?:\.\d{1,2})?)(?![\w.])/);
  const out: { budgetPerPersonUsd?: number; dietaryRestrictions?: string[] } = {};
  if (money) {
    const value = Number(money[1]);
    if (!(value > 0)) return null;
    out.budgetPerPersonUsd = value;
    text = text.replace(money[0], " ");
  }
  const rest = text
    .replace(/\b(?:per person|pp|each|a person|a head|per head|budget(?: is)?|for the (?:whole )?trip)\b/gi, " ")
    .replace(/\/\s*person\b/gi, " ")
    .replace(/^[\s,;:&+/-]+|[\s,;:&+/-]+$/g, "")
    .replace(/^(?:and|with|but)\s+/i, "")
    .trim();
  if (!rest) return money ? out : null;
  if (NONE_DIET.test(rest)) return { ...out, dietaryRestrictions: [] };
  const items = rest
    .split(/\s*(?:,|;|&|\+|\/|\band\b)\s*/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Without a budget next to it, only short diet-looking items count ("halal", "nut allergy").
  const maxWords = money ? 3 : 2;
  if (items.length === 0 || items.length > 6 || items.some((i) => i.split(/\s+/).length > maxWords || i.length > 40))
    return null; // a sentence: let Gemini read it
  if (items.some((i) => /\d|\b(?:whatever|cheap|cheapest|idk|not sure|depends|maybe|money|cost|budget)\b/.test(i)))
    return null;
  return { ...out, dietaryRestrictions: items };
}

/** "nope", "that's it", "all good" — the answer to "Anything else?" that adds nothing. */
export function isNoWish(input: string): boolean {
  return /^(?:no+|nope|nah|none|nothing|no thanks|nothing else|that'?s (?:it|all)|all good|i'?m good|good|n\/a|not really|skip|done|nada|ready|no(?:pe)?,? (?:that'?s|i'?m) (?:it|good|all))[\s.!👍]*$/iu.test(
    input.trim(),
  );
}

/**
 * A caption that points at a photo instead of saying the wish ("similar to this", "this place!", "like
 * these"). iMessage sends a photo and its caption as separate messages, in either order.
 */
export function refersToPhoto(input: string): boolean {
  const text = input.trim().toLowerCase();
  return (
    /\b(?:like|similar to|such as|more of)\s+(?:this|these|that|those)\b(?!\s+(?:trip|time|budget|date))/.test(text) ||
    /\b(?:this|that)\s+(?:one|place|spot|pic|picture|photo|post|view)\b/.test(text) ||
    /^(?:this|that|these|here|look|see)(?:\s|[!.]|👀|👆|⬆️)*$/u.test(text)
  );
}
