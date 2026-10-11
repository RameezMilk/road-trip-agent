/**
 * `npm run llm:smoke` — one structured + one grounded Gemini call, to check the key and model.
 * `npm run llm:smoke -- --image <path>` — instead reads one photo/screenshot the way the agent does.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { loadConfig, requireConfig } from "../config";
import { ImageInterpretation, ItineraryDraft, OptionalExtraction, ReplacementStop } from "../schemas";
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
const extracted = await llm.generate({
  task: "optional_extraction",
  system: "Extract road-trip wishes as short requirements.",
  prompt: 'Traveler: "I want halal food and at least 5 rest stops, and maybe a waterfall"',
  schema: OptionalExtraction,
});
console.log("structured:", extracted);
const grounded = await llm.generate({
  task: "replacement_stop",
  system: "Find one real, currently open place with Google Search.",
  prompt: "A sushi restaurant in downtown Asheville, NC for lunch. Return the stop and a one-line summary.",
  schema: ReplacementStop,
  webSearch: true,
});
console.log("grounded:", grounded);
const draft = await llm.generate({
  task: "itinerary_draft",
  system: SYSTEM.itineraryDraft,
  prompt:
    "Plan this group road trip.\nStart: Chapel Hill, NC\nEnd: Asheville, NC\nTrip type: one way\nDates: 2026-10-17 to 2026-10-17 (1 day)\nBudget: $150 per person\nDietary restrictions: halal",
  schema: ItineraryDraft,
  webSearch: true,
});
console.log(
  "itinerary:",
  draft.days.map((d) => `day ${d.day} @${d.departTime}: ${d.stops.map((s) => `${s.kind}:${s.name}`).join(" → ")}`),
);
