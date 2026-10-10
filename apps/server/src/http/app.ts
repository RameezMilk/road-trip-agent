import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

const MINIAPP_DIST = fileURLToPath(new URL("../../../miniapp/dist/", import.meta.url));

/** One origin serves the miniapp API and the built miniapp, so Photon cards need a single HTTPS URL. */
export function createHttpApp() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  // Shared trip view: readiness, eligible choices, aggregates, itinerary facts — never private answers.
  app.get("/api/trips/:publicId/state", (c) =>
    c.json({ error: "not_implemented", detail: "Trip state is built after the Photon probe passes." }, 501),
  );

  if (existsSync(MINIAPP_DIST)) {
    // serveStatic resolves `root` against the process cwd.
    const root = relative(process.cwd(), MINIAPP_DIST) || ".";
    app.use("/assets/*", serveStatic({ root }));
    // SPA fallback: every miniapp route renders index.html.
    app.get("/trip/*", serveStatic({ root, rewriteRequestPath: () => "/index.html" }));
  }

  return app;
}
