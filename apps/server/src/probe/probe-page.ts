import { Hono } from "hono";
import { z } from "zod";
import { CODE_TTL_MS, type ProbeStore } from "./probe-store";

export type ProbeLog = (event: string, data: Record<string, unknown>) => void;

interface ProbeRouteDeps {
  store: ProbeStore;
  log: ProbeLog;
  mapsBrowserKey?: string | undefined;
  mapId?: string | undefined;
}

const beaconSchema = z.object({
  reason: z.enum(["load", "manual", "map"]),
  pageSessionId: z.string().max(64),
  query: z.record(z.string(), z.string().max(200)).default({}),
  userAgent: z.string().max(500).default(""),
  viewport: z.string().max(64).default(""),
  referrer: z.string().max(500).default(""),
  mapResult: z.string().max(200).optional(),
});

// Headers that could carry credentials are never logged.
const REDACTED_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);
const RATE_LIMIT_PER_MINUTE = 30;

export function probeRoutes({ store, log, mapsBrowserKey, mapId }: ProbeRouteDeps) {
  const app = new Hono();
  const hits = new Map<string, number[]>();

  app.get("/probe", (c) => {
    log("probe_page_get", { query: c.req.query(), headers: loggableHeaders(c.req.raw.headers) });
    return c.html(renderProbePage({ mapsBrowserKey, mapId: mapId ?? "DEMO_MAP_ID" }));
  });

  app.post("/api/probe/beacon", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= RATE_LIMIT_PER_MINUTE) return c.json({ error: "rate_limited" }, 429);
    hits.set(ip, [...recent, now]);

    const parsed = beaconSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const beacon = parsed.data;
    log("probe_beacon", { ...beacon, headers: loggableHeaders(c.req.raw.headers) });

    if (beacon.reason === "map") return c.json({ ok: true });
    const session = store.mint({ cardSpaceHash: beacon.query.s ?? null, userAgent: beacon.userAgent });
    return c.json({ code: session.code, expiresInSeconds: CODE_TTL_MS / 1000 });
  });

  return app;
}

function loggableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = REDACTED_HEADERS.has(key) ? "[redacted]" : value.slice(0, 200);
  });
  return out;
}

function renderProbePage(cfg: { mapsBrowserKey?: string | undefined; mapId: string }) {
  // JSON in a <script> block: escape "<" so values can't close the tag.
  const cfgJson = JSON.stringify({ mapsBrowserKey: cfg.mapsBrowserKey ?? null, mapId: cfg.mapId }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Road-trip probe</title>
<meta property="og:title" content="Road-trip probe">
<meta property="og:description" content="Tap to test the miniapp card">
<style>
  :root { color-scheme: light; --ink:#0b3a5b; --muted:#3f6a86; --glass:rgba(255,255,255,.62); --edge:rgba(255,255,255,.9); --aqua:#16a5d8; --leaf:#3fae49; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; font:16px/1.45 "Segoe UI","Frutiger","Myriad Pro","Helvetica Neue",system-ui,sans-serif; color:var(--ink);
    background: radial-gradient(120% 60% at 50% 0%, #e9fbff 0%, #9fdcf7 45%, #4fb3e8 100%); padding: 16px; }
  .glass { background:var(--glass); border:1px solid var(--edge); border-radius:20px; padding:16px; margin:0 auto 14px; max-width:560px;
    box-shadow: 0 8px 24px rgba(11,58,91,.18), inset 0 1px 0 #fff; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  h1 { font-size:20px; margin:0 0 4px; } p { margin:6px 0; color:var(--muted); }
  .code { font: 700 34px/1.1 ui-monospace, Menlo, monospace; letter-spacing:.12em; color:var(--ink); margin:8px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; } td { padding:4px 6px; vertical-align:top; border-top:1px solid rgba(11,58,91,.12); word-break:break-word; }
  td:first-child { color:var(--muted); white-space:nowrap; width:1%; }
  button { min-height:44px; padding:0 18px; border-radius:999px; border:1px solid rgba(255,255,255,.9); font:600 15px inherit; color:#fff; cursor:pointer;
    background: linear-gradient(180deg, #5fd0f5 0%, var(--aqua) 55%, #0d86b6 100%); box-shadow: inset 0 1px 0 rgba(255,255,255,.8), 0 3px 8px rgba(13,134,182,.35); }
  button.green { background: linear-gradient(180deg, #8fe07f 0%, var(--leaf) 55%, #2b8a34 100%); }
  #map { height:220px; border-radius:14px; margin-top:10px; display:none; }
  .status { font-size:14px; }
</style>
</head>
<body>
  <section class="glass">
    <h1>Road-trip probe</h1>
    <p>This page tests whether a Spectrum app card opens inside Messages and can reach our server.</p>
  </section>
  <section class="glass">
    <div class="status" id="beaconStatus">Contacting server…</div>
    <div class="code" id="code" aria-live="polite"></div>
    <p id="codeHelp" hidden>Send <b>/confirm <span id="codeInline"></span></b> in the same chat within 10 minutes. The bot will tie this page session to your chat identity.</p>
    <button type="button" id="again">Send beacon again</button>
  </section>
  <section class="glass">
    <table id="info"></table>
  </section>
  <section class="glass" id="mapSection" hidden>
    <p>Optional: does Google Maps render inside the Messages webview?</p>
    <button type="button" class="green" id="loadMap">Load map</button>
    <div id="map"></div>
    <div class="status" id="mapStatus"></div>
  </section>
<script id="cfg" type="application/json">${cfgJson}</script>
<script>
(() => {
  const cfg = JSON.parse(document.getElementById("cfg").textContent);
  const $ = (id) => document.getElementById(id);
  const info = {
    pageSessionId: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
    query: Object.fromEntries(new URLSearchParams(location.search)),
    userAgent: navigator.userAgent,
    viewport: innerWidth + "x" + innerHeight + "@" + devicePixelRatio,
    referrer: document.referrer,
  };
  const rows = [["Opened", new Date().toISOString()], ["Query", JSON.stringify(info.query)], ["User agent", info.userAgent],
    ["Viewport", info.viewport], ["Referrer", info.referrer || "(none)"], ["Origin", location.origin]];
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const a = document.createElement("td"); a.textContent = k;
    const b = document.createElement("td"); b.textContent = v;
    tr.append(a, b); $("info").append(tr);
  }
  async function beacon(reason, extra) {
    const res = await fetch("/api/probe/beacon", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...info, reason, ...(extra || {}) }) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  async function sendBeacon(reason) {
    $("beaconStatus").textContent = "Contacting server…";
    try {
      const { code } = await beacon(reason);
      $("beaconStatus").textContent = "✅ Server reached — beacon logged.";
      $("code").textContent = code; $("codeInline").textContent = code; $("codeHelp").hidden = false;
    } catch (e) {
      $("beaconStatus").textContent = "❌ Could not reach server: " + e.message;
    }
  }
  $("again").addEventListener("click", () => sendBeacon("manual"));
  sendBeacon("load");

  if (cfg.mapsBrowserKey) {
    $("mapSection").hidden = false;
    $("loadMap").addEventListener("click", () => {
      $("mapStatus").textContent = "Loading Maps JS…";
      const report = (mapResult) => { $("mapStatus").textContent = mapResult; beacon("map", { mapResult }).catch(() => {}); };
      window.gm_authFailure = () => report("❌ Maps auth failure (key/referrer restriction)");
      window.__probeMapReady = async () => {
        try {
          const { Map } = await google.maps.importLibrary("maps");
          const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
          const el = $("map"); el.style.display = "block";
          const center = { lat: 35.9132, lng: -79.0558 }; // Chapel Hill, NC
          const map = new Map(el, { center, zoom: 9, mapId: cfg.mapId, disableDefaultUI: true });
          new AdvancedMarkerElement({ map, position: center, title: "Chapel Hill" });
          google.maps.event.addListenerOnce(map, "tilesloaded", () => report("✅ Map tiles + Advanced Marker rendered"));
        } catch (e) { report("❌ Map error: " + e.message); }
      };
      const s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(cfg.mapsBrowserKey) + "&v=weekly&loading=async&callback=__probeMapReady";
      s.onerror = () => report("❌ Maps script failed to load");
      document.head.append(s);
    }, { once: true });
  }
})();
</script>
</body>
</html>`;
}
