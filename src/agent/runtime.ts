import type { InboundEvent, InboundImage } from "../chat/spectrum";
import type { Repo } from "../db/repo";
import { copy } from "./copy";
import type { Engine, Log } from "./engine";
import { KeyedQueue } from "./keyed-queue";

/** Phases where a photo means something (a wish while planning, feedback while reviewing, a new stop on the road). */
const PHOTO_PHASES = new Set(["planning", "review", "execution"]);
/** Inline image limit for Gemini requests, with headroom for base64 and the prompt. */
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const IMAGE_READ_TIMEOUT_MS = 20_000;

/**
 * Pumps the chat stream into the engine:
 * - records every inbound event per member (the insert doubles as the at-least-once dedupe),
 * - ignores group chats (Photon Pro never delivers them anyway), read receipts and reactions,
 * - answers attachments/voice with "text only", and
 * - keeps each sender's messages in order while different senders run concurrently.
 */
export async function runChatLoop(deps: {
  messages: AsyncIterable<InboundEvent>;
  engine: Engine;
  repo: Repo;
  log: Log;
}): Promise<void> {
  const { engine, repo, log } = deps;
  const perSender = new KeyedQueue();
  for await (const ev of deps.messages) {
    if (!ev.handle) continue;
    const handle = ev.handle;
    const active = await repo.findActiveMembership(handle).catch(() => null);
    const fresh = await repo
      .recordChatEvent({ ...ev.event, tripId: active?.trip.id ?? null, memberId: active?.member.id ?? null })
      .catch((error) => {
        log("record_inbound_failed", { error: String(error) });
        return true; // the stream's in-memory dedupe already ran; don't drop the message
      });
    if (!fresh || ev.isGroup) continue;

    const to = { handle, chatId: ev.chatId, memberId: active?.member.id ?? null, tripId: active?.trip.id ?? null };
    if (ev.image && active && PHOTO_PHASES.has(active.trip.phase)) {
      const image = ev.image;
      const work = perSender
        .run(handle, async () => {
          // Say so right away: downloading a photo from Photon can take several seconds.
          await engine.sendTo(to, copy.photoLooking());
          const data = await readImage(image).catch((error) => {
            log("photo_read_failed", { error: String(error), mimeType: image.mimeType });
            return null;
          });
          if (!data) return void (await engine.sendTo(to, copy.photoUnreadable()));
          log("photo_read", { mimeType: image.mimeType, bytes: data.length });
          await engine.receive({
            messageId: ev.messageId,
            handle,
            chatId: ev.chatId,
            text: ev.text ?? "", // the caption, when the photo came with one
            receivedAt: ev.occurredAt,
            image: { mimeType: image.mimeType, data },
            acknowledged: true,
          });
        })
        .catch((error) => {
          log("receive_failed", { error: String(error) });
        });
      engine.track(work);
      continue;
    }
    if (ev.kind === "attachment" || ev.kind === "voice") {
      void engine.sendTo(to, ev.image ? copy.photoNotNow() : copy.textOnly());
      continue;
    }
    if (ev.kind !== "text" || !ev.text?.trim()) continue;

    const msg = { messageId: ev.messageId, handle, chatId: ev.chatId, text: ev.text, receivedAt: ev.occurredAt };
    const work = perSender
      .run(handle, () => engine.receive(msg))
      .catch((error) => {
        log("receive_failed", { error: String(error) });
      });
    engine.track(work);
  }
}

async function readImage(image: InboundImage): Promise<Buffer> {
  if (image.size !== null && image.size > MAX_IMAGE_BYTES) throw new Error(`too large (${image.size} bytes)`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("read timed out")), IMAGE_READ_TIMEOUT_MS);
  });
  try {
    const data = await Promise.race([image.read(), timeout]);
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`too large (${data.length} bytes)`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
