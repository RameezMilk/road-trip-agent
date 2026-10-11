import { ImageInterpretation, RequirementText } from "../../schemas";
import { conversationBlock, SYSTEM } from "../../services/prompts";
import type { Ctx, Engine } from "../engine";

/**
 * Photos a member sends while planning or reviewing: a screenshot of a post about a place they want to visit,
 * or a view they'd like more stops like. Gemini reads the image (with Google Search to place it); code turns
 * the result into wish / feedback text, so everything downstream stays the existing text pipeline.
 */
export interface PhotoReading {
  interpretation: ImageInterpretation;
  /** The wish to record, or null for an unrelated image. */
  wish: string | null;
}

export async function interpretPhoto(e: Engine, ctx: Ctx, trip: string): Promise<PhotoReading> {
  const image = ctx.msg.image;
  if (!image) throw new Error("interpretPhoto needs an image");
  const history = await e.repo.recentConversation(ctx.member.id, ctx.msg.messageId).catch(() => []);
  const interpretation = await e.llm.generate({
    task: "image_interpretation",
    system: SYSTEM.imageInterpretation,
    prompt: `${conversationBlock(history)}Trip: ${trip}\nThe member just sent the attached image.`,
    schema: ImageInterpretation,
    webSearch: true,
    images: [{ mimeType: image.mimeType, base64: image.data.toString("base64") }],
  });
  return { interpretation, wish: wishFor(interpretation) };
}

export function wishFor(it: ImageInterpretation): string | null {
  const description = it.description.trim().replace(/[.\s]+$/, "");
  let text: string | null = null;
  if (it.kind === "place" && it.placeName?.trim()) {
    text = `Visit ${it.placeName.trim()}${it.city?.trim() ? `, ${it.city.trim()}` : ""}`;
  } else if (it.kind === "scene" && description) {
    text = `Include stops similar to: ${description}`;
  }
  return text ? (RequirementText.safeParse(text.slice(0, 200)).data ?? null) : null;
}

/** The feedback a photo stands for during review. */
export function feedbackFor(it: ImageInterpretation): string | null {
  const wish = wishFor(it);
  if (!wish) return null;
  return it.kind === "place" ? wish.replace(/^Visit /, "Add a stop at ") : wish.replace(/^Include /, "Add ");
}
