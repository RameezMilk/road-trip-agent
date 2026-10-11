import type { InboundEvent } from "../chat/spectrum";
import type { Repo } from "../db/repo";
import { copy } from "./copy";
import type { Engine, Log } from "./engine";
import { KeyedQueue } from "./keyed-queue";

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
    if (ev.kind === "attachment" || ev.kind === "voice") {
      void engine.sendTo(to, copy.textOnly());
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
