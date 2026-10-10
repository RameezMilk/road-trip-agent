/**
 * Read-only export of a DM's full history from Photon, oldest → newest.
 *
 *   npm run probe:history -- --with +14085550101[,+1…]
 *
 * Writes exports/history-<last4>-<timestamp>.txt (human-readable) and .jsonl (one row per message — the shape we'd
 * stream into Tiger Data). exports/ is gitignored: it contains real message text.
 *
 * spectrum-ts doesn't expose history, so this reaches the underlying @photon-ai/advanced-imessage client through
 * Spectrum's internal platform registry. Probe-only: an SDK upgrade may move that internal.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { loadConfig, requireConfig } from "../config";

// Minimal view of advanced-imessage's MessagesResource / Message (only what we read).
interface HistoryMessage {
  guid: string;
  dateCreated: Date;
  isFromMe: boolean;
  itemType: string;
  isAudioMessage: boolean;
  sender?: { address: string; service: string };
  content: {
    text?: string;
    /** Set for iMessage app balloons — polls, app cards, card updates. */
    balloonBundleId?: string;
    attachments: readonly { fileName: string; mimeType: string; totalBytes: number }[];
    miniApp?: { url?: string; live: boolean };
  };
  reaction?: { kind: string; emoji?: string };
  reactionTargetGuid?: string;
  replyTargetGuid?: string;
}
interface HistoryPage {
  messages: readonly HistoryMessage[];
  nextPageToken?: string;
}
interface HistoryClient {
  messages: { listInChat(chat: string, options?: { pageSize?: number; pageToken?: string }): Promise<HistoryPage> };
}
type InternalSpectrum = { __internal: { platforms: Map<string, { client: unknown }> } };

const MAX_PAGES = 200; // 100 per page → 20k messages; a safety stop, not an expected limit

const { values: args, positionals } = parseArgs({ options: { with: { type: "string" } }, allowPositionals: true });
const config = requireConfig(loadConfig(), "History export", ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET"]);

const peers = [args.with ?? "", ...positionals]
  .join(",")
  .split(",")
  .map((p) => p.replace(/[^\d+]/g, ""))
  .filter(Boolean)
  .map((d) => (d.startsWith("+") ? d : d.length === 10 ? `+1${d}` : `+${d}`));
if (peers.length === 0) {
  console.error("Usage: npm run probe:history -- --with +14085550101[,+1…]");
  process.exit(1);
}

const spectrum = await Spectrum({
  projectId: config.SPECTRUM_PROJECT_ID,
  projectSecret: config.SPECTRUM_PROJECT_SECRET,
  providers: [imessage.config()],
  telemetry: false,
});

const runtime = (spectrum as unknown as InternalSpectrum).__internal.platforms.get("imessage");
const entries = runtime?.client as { phone: string; client: HistoryClient }[] | undefined;
const history = entries?.[0]?.client;
if (!history?.messages?.listInChat) {
  console.error(
    `Could not reach the iMessage history client (platforms: ${[...((spectrum as unknown as InternalSpectrum).__internal.platforms.keys() ?? [])].join(", ")})`,
  );
  await spectrum.stop();
  process.exit(1);
}

const outDir = fileURLToPath(new URL("../../../../exports/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

for (const peer of peers) {
  const chat = `any;-;${peer}`; // same DM id the SDK builds for space.create on a shared line
  const messages: HistoryMessage[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  try {
    do {
      const page = await history.messages.listInChat(chat, { pageSize: 100, ...(pageToken && { pageToken }) });
      messages.push(...page.messages);
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken && pages < MAX_PAGES);
  } catch (err) {
    const e = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`…${peer.slice(-4)}: history request failed after ${pages} page(s) — ${e}`);
    continue;
  }

  // Oldest first; guid breaks ties so the order is stable across runs.
  messages.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime() || a.guid.localeCompare(b.guid));

  const rows = messages.map((m) => ({
    time: m.dateCreated.toISOString(),
    id: m.guid,
    chat,
    from: m.isFromMe ? "agent" : "user",
    itemType: m.itemType,
    kind: kindOf(m),
    text: m.content.text ?? null,
    attachments: m.content.attachments.map((a) => ({ name: a.fileName, mimeType: a.mimeType, bytes: a.totalBytes })),
    reaction: m.reaction ? (m.reaction.emoji ?? m.reaction.kind) : null,
    reactionTarget: m.reactionTargetGuid ?? null,
    replyTo: m.replyTargetGuid ?? null,
    appCardUrl: m.content.miniApp?.url ?? null,
    balloon: m.content.balloonBundleId ?? null,
  }));

  const first = rows[0]?.time ?? "-";
  const last = rows.at(-1)?.time ?? "-";
  const lines = [
    `Photon DM history export (read-only)`,
    `exported:  ${new Date().toISOString()}`,
    `chat:      any;-;…${peer.slice(-4)}`,
    `messages:  ${rows.length} (${pages} page(s) of ≤100)`,
    `range:     ${first} → ${last}`,
    `order:     oldest → newest by dateCreated`,
    "",
    "time (UTC)                 | from  | kind        | id                                   | content",
    "-".repeat(120),
    ...rows.map(
      (r) => `${r.time.padEnd(26)} | ${r.from.padEnd(5)} | ${r.kind.padEnd(11)} | ${r.id.padEnd(36)} | ${describe(r)}`,
    ),
    "",
  ];

  const base = `${outDir}history-${peer.slice(-4)}-${stamp}`;
  writeFileSync(`${base}.txt`, lines.join("\n"));
  writeFileSync(`${base}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  console.log(`…${peer.slice(-4)}: ${rows.length} messages (${first} → ${last}) → ${base}.txt (+ .jsonl)`);
}

await spectrum.stop();
process.exit(0);

function kindOf(m: HistoryMessage): string {
  if (m.reaction) return "reaction";
  if (m.content.miniApp) return "app_card";
  if (m.content.balloonBundleId) return "balloon";
  if (m.isAudioMessage) return "voice";
  if (m.content.attachments.length > 0) return m.content.text ? "text+attach" : "attachment";
  if (m.itemType !== "normal") return m.itemType;
  return "text";
}

function describe(r: {
  text: string | null;
  attachments: { name: string; mimeType: string; bytes: number }[];
  reaction: string | null;
  reactionTarget: string | null;
  appCardUrl: string | null;
  balloon: string | null;
}): string {
  const parts: string[] = [];
  if (r.text) parts.push(JSON.stringify(r.text));
  for (const a of r.attachments) parts.push(`[${a.mimeType} ${a.name} ${Math.max(1, Math.round(a.bytes / 1024))}KB]`);
  if (r.reaction) parts.push(`[reacted ${r.reaction} to ${r.reactionTarget ?? "?"}]`);
  if (r.appCardUrl) parts.push(`[app card ${r.appCardUrl}]`);
  else if (r.balloon) parts.push(`[iMessage app balloon ${r.balloon}]`);
  return parts.join(" ") || "(no text)";
}
