/**
 * `npm run llm:smoke` — structured, grounded and draft Gemini calls with timings (checks key, model, latency).
 * `npm run llm:smoke -- --image <path>` — instead reads one photo/screenshot the way the agent does.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { loadConfig, requireConfig } from "../config";
import {
  ImageInterpretation,
  ItineraryDraft,
  OptionalExtraction,
  PredefinedExtraction,
  ReplacementStop,
} from "../schemas";
import { GeminiLlm } from "../services/gemini";
import { SYSTEM } from "../services/prompts";

const config = requireConfig(loadConfig(), "Gemini", ["GEMINI_API_KEY"]);
const llm = new GeminiLlm(config.GEMINI_API_KEY, config.GEMINI_MODEL, (event, data) => console.log(event, data ?? ""));
console.log(`model: ${config.GEMINI_MODEL}`);

const imageArg = process.argv.indexOf("--image");
if (imageArg >= 0) {
  const path = process.argv[imageArg + 1];
  if (!path) throw new Error("usage: npm run llm:smoke -- --image <path>");
  const ext = extname(path).slice(1).toLowerCase();
  const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
  const image = await llm.generate({
    task: "image_interpretation",
    system: SYSTEM.imageInterpretation,
    prompt: "Trip: Chapel Hill, NC → Asheville, NC\nThe member just sent the attached image.",
    schema: ImageInterpretation,
    webSearch: true,
    images: [{ mimeType, base64: (await readFile(path)).toString("base64") }],
  });
  console.log("image:", image);
  process.exit(0);
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await run();
  console.log(`⏱  ${label}: ${Date.now() - started} ms`);
  return result;
}

const extracted = await timed("optional_extraction (structured)", () =>
  llm.generate({
    task: "optional_extraction",
    system: SYSTEM.optionalExtraction,
    prompt: 'Traveler: "I want halal food and at least 5 rest stops, and maybe a waterfall"',
    schema: OptionalExtraction,
  }),
);
console.log("structured:", extracted);
const predefined = await timed("predefined_extraction (structured)", () =>
  llm.generate({
    task: "predefined_extraction",
    system: SYSTEM.predefinedExtraction,
    prompt: `Today is 2026-10-11 (America/New_York).\nThe agent just asked for: destination.\nAlready known: {}\nTraveler's message: """wilmingtn from chapel hil"""`,
    schema: PredefinedExtraction,
  }),
);
console.log("predefined:", predefined);
const grounded = await timed("replacement_stop (grounded)", () =>
  llm.generate({
    task: "replacement_stop",
    system: SYSTEM.replacementStop,
    prompt: "A sushi restaurant in downtown Asheville, NC for lunch. Return the stop and a one-line summary.",
    schema: ReplacementStop,
    webSearch: true,
  }),
);
console.log("grounded:", grounded.stop.name);
const maxStops = config.MAX_STOPS;
const draft = await timed(`itinerary_draft (grounded, ≤${maxStops} stops)`, () =>
  llm.generate({
    task: "itinerary_draft",
    system: SYSTEM.itineraryDraft(maxStops),
    prompt:
      "Plan this group road trip.\nStart: Chapel Hill, NC\nEnd: Asheville, NC\nTrip type: round trip (return to start on the last day)\nDates: 2026-10-18 to 2026-10-19 (2 days)\nBudget: $250 per person for the whole trip\nDietary restrictions (apply to the whole group): halal\nAdopted wishes: [other] beach day\nGroup decisions: none",
    schema: ItineraryDraft,
    webSearch: true,
  }),
);
console.log(
  "itinerary:",
  draft.days.map((d) => `day ${d.day} @${d.departTime}: ${d.stops.map((s) => `${s.kind}:${s.name}`).join(" → ")}`),
);
