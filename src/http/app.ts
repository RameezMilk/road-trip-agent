import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Engine } from "../agent/engine";
import type { Repo } from "../db/repo";
import { METERS_PER_MILE } from "../domain/geo";
import { PollToken, PollWidgetSubmission, PollWidgetView, PublicId } from "../schemas";
import { buildDashboard } from "./dashboard";

const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Tiny fixed-window limiter for the poll widget POST (per token). */
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  };
}

export function createHttpApp(deps: { repo: Repo; engine: Engine | null }) {
  const { repo, engine } = deps;
  const app = new Hono();
  const allowVote = rateLimiter(10, 60_000);

  app.get("/health", (c) => c.json({ ok: true }));

  // --- read-only trip dashboard API ---------------------------------------------------------------
  app.get("/api/trips/:publicId", async (c) => {
    const publicId = PublicId.safeParse(c.req.param("publicId"));
    if (!publicId.success) return c.json({ error: "not_found" }, 404);
    const trip = await repo.getTripByPublicId(publicId.data);
    if (!trip) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(await buildDashboard(repo, trip));
  });

  // --- dashboard page, with Open Graph tags for the iMessage card ---------------------------------
  app.get("/trip/:publicId", async (c) => {
    const html = await readFile(`${WEB_DIR}dashboard.html`, "utf8");
    const publicId = PublicId.safeParse(c.req.param("publicId"));
    const trip = publicId.success ? await repo.getTripByPublicId(publicId.data) : null;
    let title = "Road trip";
    let description = "Your group's road trip dashboard";
    if (trip) {
      const itinerary = trip.currentVersion > 0 ? await repo.getItinerary(trip.id, trip.currentVersion) : null;
      title = itinerary?.title ?? trip.title;
      if (itinerary) {
        const miles = Math.round(itinerary.totals.distanceMeters / METERS_PER_MILE);
        description = `${itinerary.startLocation} → ${itinerary.endLocation} · ${miles} mi · ${itinerary.stops.length} stops`;
      }
    }
    const og = [
      `<title>${escapeHtml(title)}</title>`,
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(description)}">`,
      `<meta property="og:type" content="website">`,
    ].join("\n    ");
    return c.html(html.replace("<!--OG-->", og));
  });

  // --- poll widget ---------------------------------------------------------------------------------
  app.get("/poll/:token", async (c) => c.html(await readFile(`${WEB_DIR}poll.html`, "utf8")));

  app.get("/api/polls/:token", async (c) => {
    const token = PollToken.safeParse(c.req.param("token"));
    if (!token.success) return c.json({ error: "not_found" }, 404);
    const found = await repo.resolvePollToken(token.data);
    if (!found) return c.json({ error: "not_found" }, 404);
    const votes = await repo.listVotes(found.poll.id);
    const voters = (await repo.listMembers(found.trip.id)).filter((m) => m.status === "joined").length;
    c.header("Cache-Control", "no-store");
    return c.json(
      PollWidgetView.parse({
        question: found.poll.question,
        status: found.poll.status,
        options: found.poll.options.map((o) => ({ id: o.id, label: o.label })),
        myOptionId: votes.find((v) => v.memberId === found.member.id)?.optionId ?? null,
        votesCast: votes.length,
        voters,
      }),
    );
  });

  app.post("/api/polls/:token", async (c) => {
    const token = PollToken.safeParse(c.req.param("token"));
    if (!token.success) return c.json({ error: "not_found" }, 404);
    if (!allowVote(token.data)) return c.json({ error: "rate_limited" }, 429);
    if (!engine) return c.json({ error: "agent_offline" }, 503);
    const body = PollWidgetSubmission.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const result = await engine.submitWidgetVote(token.data, body.data);
    if (!result.ok) return c.json({ error: result.error }, result.error === "unknown_poll" ? 404 : 409);
    return c.json(result);
  });

  // --- static assets ---------------------------------------------------------------------------------
  app.use(
    "/web/*",
    serveStatic({ root: relative(process.cwd(), WEB_DIR) || ".", rewriteRequestPath: (p) => p.replace(/^\/web/, "") }),
  );

  app.get("/", (c) => c.text("Road Trip Agent is running. Open a trip dashboard from its iMessage card."));
  return app;
}
