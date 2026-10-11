// Trip dashboard (Photon mini-app). Reads GET /api/trips/:publicId (TripDashboard schema) and renders an
// OpenStreetMap/Leaflet map, a tappable schedule and sustainability "energy bars". Refreshes every 20 s.
(() => {
  const ICONS = {
    origin: "🏠",
    destination: "🏁",
    restaurant: "🍽️",
    gas: "⛽",
    rest_stop: "🚻",
    lodging: "🏨",
    scenic: "🏞️",
    attraction: "🎟️",
    charging: "⚡",
  };
  const LABELS = {
    origin: "Start / home",
    destination: "Destination",
    restaurant: "Food",
    gas: "Gas",
    rest_stop: "Rest stop",
    lodging: "Lodging",
    scenic: "Scenic",
    attraction: "Attraction",
    charging: "EV charging",
  };
  const PHASES = {
    onboarding: "Gathering crew",
    planning: "Planning",
    voting: "Voting",
    drafting: "Drafting",
    review: "Awaiting approval",
    execution: "On the road",
    aborted: "Ended",
  };
  const METERS_PER_MILE = 1609.344;

  const publicId = location.pathname.split("/").filter(Boolean)[1] ?? "";
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  let map = null;
  let layer = null;
  let markers = new Map();
  let lastUpdatedAt = null;
  let activeStopId = null;
  let fitted = false;

  // --- layout mode: the in-thread bubble is tiny, so it only gets a one-line summary ----------------
  function applyMode() {
    document.body.classList.toggle("bubble", window.innerHeight < 120);
  }
  window.addEventListener("resize", () => {
    applyMode();
    map?.invalidateSize();
  });
  applyMode();

  // --- formatting -----------------------------------------------------------------------------------
  const fmtTime = (iso, tz) =>
    iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "";
  const fmtDate = (iso, tz) =>
    new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const fmtDuration = (seconds) => {
    const m = Math.round(seconds / 60);
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  };
  const money = (n) =>
    `$${Number(n)
      .toFixed(n >= 100 ? 0 : 2)
      .replace(/\.00$/, "")}`;
  const gmaps = (s) => `https://www.google.com/maps/search/?api=1&query=${s.latLng.lat},${s.latLng.lng}`;

  function currentIndex(stops) {
    const now = Date.now();
    let idx = -1;
    stops.forEach((s, i) => {
      if (s.arriveAt && Date.parse(s.arriveAt) <= now) idx = i;
    });
    return idx;
  }

  // --- map --------------------------------------------------------------------------------------------
  function ensureMap() {
    if (map || typeof L === "undefined") return;
    map = L.map("map", { zoomControl: false, scrollWheelZoom: false, attributionControl: true });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }

  function popupHtml(s, it) {
    const time = s.arriveAt
      ? `${fmtTime(s.arriveAt, it.timeZone)}${s.departAt ? ` – ${fmtTime(s.departAt, it.timeZone)}` : ""}`
      : `Departs ${fmtTime(s.departAt, it.timeZone)}`;
    return `<div class="popup">
      <h3>${ICONS[s.kind]} ${esc(s.name)}</h3>
      <p><span class="tag">${esc(LABELS[s.kind])}</span> ${s.sustainable ? '<span class="tag green">🌱 green</span>' : ""}
      ${s.geocodeSource === "approximate" ? '<span class="tag warn">approx. location</span>' : ""}</p>
      <p><b>${esc(time)}</b>${s.dwellMinutes && s.kind !== "lodging" && s.departAt && s.arriveAt ? ` · ${s.dwellMinutes} min` : ""}</p>
      ${s.address ? `<p>${esc(s.address)}</p>` : ""}
      ${s.note ? `<p>${esc(s.note)}</p>` : ""}
      ${s.webEstimateCostPerPersonUsd != null ? `<p>≈ ${money(s.webEstimateCostPerPersonUsd)}/person <span class="tag">Gemini web estimate</span></p>` : ""}
      ${s.sourceUrl ? `<p><a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">Source</a></p>` : ""}
      <a class="gmaps" href="${gmaps(s)}" target="_blank" rel="noopener">Open in Google Maps</a>
    </div>`;
  }

  function renderMap(it) {
    ensureMap();
    if (!map) return;
    layer.clearLayers();
    markers = new Map();
    const done = currentIndex(it.stops);
    for (const leg of it.legs) {
      if (leg.geometry.length < 2) continue;
      const dashed = leg.source === "estimate" ? "8 8" : null;
      L.polyline(leg.geometry, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(layer);
      L.polyline(leg.geometry, { color: "#16a5d8", weight: 4.5, opacity: 0.95, dashArray: dashed }).addTo(layer);
    }
    it.stops.forEach((s, i) => {
      const classes = ["pin", s.geocodeSource === "approximate" ? "approx" : "", i < done ? "done" : ""].join(" ");
      const icon = L.divIcon({
        className: "",
        html: `<div class="${classes}" style="--pin: var(--k-${s.kind})"><span>${ICONS[s.kind]}</span><span class="n">${i + 1}</span></div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        popupAnchor: [0, -16],
      });
      const marker = L.marker([s.latLng.lat, s.latLng.lng], { icon, title: s.name, riseOnHover: true })
        .bindTooltip(`<b>${esc(s.name)}</b><br>${esc(fmtTime(s.arriveAt ?? s.departAt, it.timeZone))}`, {
          direction: "top",
          offset: [0, -16],
        })
        .bindPopup(popupHtml(s, it), { maxWidth: 240, autoPanPadding: [16, 16] })
        .on("click", () => highlight(s.id, false))
        .addTo(layer);
      markers.set(s.id, marker);
    });
    if (!fitted && it.stops.length) {
      map.fitBounds(L.latLngBounds(it.stops.map((s) => [s.latLng.lat, s.latLng.lng])), { padding: [24, 24] });
      fitted = true;
    }
  }

  function focusStop(id) {
    const marker = markers.get(id);
    if (!marker || !map) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 12), { duration: 0.6 });
    marker.openPopup();
    highlight(id, false);
  }

  function highlight(id, scroll) {
    activeStopId = id;
    for (const el of document.querySelectorAll(".stop")) {
      const on = el.dataset.id === id;
      el.classList.toggle("active", on);
      if (on && scroll) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // --- panel ------------------------------------------------------------------------------------------
  function meter(title, fraction, right, hint) {
    const f = Math.max(0, Math.min(1, fraction || 0));
    const cells = Array.from({ length: 10 }, (_, i) => {
      const fill = f * 10 - i;
      return `<div class="cell${fill >= 1 ? " on" : fill > 0.25 ? " on half" : ""}"></div>`;
    }).join("");
    return `<div class="meter" role="img" aria-label="${esc(`${title}: ${Math.round(f * 100)}%`)}">
      <div class="label"><span>${esc(title)}</span><span>${esc(right)}</span></div>
      <div class="cells">${cells}</div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ""}
    </div>`;
  }

  /** "Next: … · 2:15 PM", or "Starts Sat, Oct 17 · 8:30 AM" before departure. */
  function nextUpLine(it, idx) {
    const tz = it.timeZone;
    if (idx < 0) {
      const first = it.stops[0];
      return first?.departAt
        ? `🚦 <b>Starts</b> ${esc(fmtDate(first.departAt, tz))} · ${esc(fmtTime(first.departAt, tz))}`
        : "";
    }
    const next = it.stops[idx + 1];
    if (!next) return "🏁 <b>Trip complete!</b>";
    return `⏭️ <b>Next:</b> ${ICONS[next.kind]} ${esc(next.name)} · ${esc(fmtTime(next.arriveAt, tz))}`;
  }

  function renderPanel(d) {
    const it = d.itinerary;
    const panel = $("panel");
    if (!it) {
      panel.innerHTML = `<p class="notice">${esc(PHASES[d.phase] ?? d.phase)} — the itinerary appears here once it's drafted.</p>
        <section class="section"><h2>Crew</h2><ul class="list">${d.members.map((m) => `<li>${esc(m.name)}</li>`).join("")}</ul></section>`;
      return;
    }
    const tz = it.timeZone;
    const idx = currentIndex(it.stops);
    const t = it.totals;
    const su = it.sustainability;
    const miles = Math.round(t.distanceMeters / METERS_PER_MILE);

    let schedule = "";
    let day = 0;
    it.stops.forEach((s, i) => {
      if (s.day !== day) {
        day = s.day;
        const when = s.departAt ?? s.arriveAt;
        schedule += `<div class="day">Day ${day}${when ? ` · ${esc(fmtDate(when, tz))}` : ""}</div>`;
      }
      const at = s.arriveAt ?? s.departAt;
      const meta = [
        LABELS[s.kind],
        s.dwellMinutes && s.kind !== "lodging" && s.arriveAt && s.departAt ? `${s.dwellMinutes} min` : "",
        s.geocodeSource === "approximate" ? "approx." : "",
        s.sustainable ? "🌱" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      schedule += `<button class="stop${i <= idx ? " done" : ""}${s.id === activeStopId ? " active" : ""}" data-id="${esc(s.id)}" type="button">
        <span class="time">${esc(fmtTime(at, tz))}</span>
        <span class="orb" style="--pin: var(--k-${s.kind})" aria-hidden="true">${ICONS[s.kind]}</span>
        <span><span class="name">${esc(s.name)}</span><br><span class="meta">${esc(meta)}</span></span>
      </button>`;
    });

    const carpoolFraction = su.soloFuelGallons ? su.gallonsSavedByCarpool / su.soloFuelGallons : 0;
    const co2Fraction = su.co2KgPerPersonSolo ? 1 - su.co2KgPerPerson / su.co2KgPerPersonSolo : 0;

    panel.innerHTML = `
      <div class="next-up">${nextUpLine(it, idx)}</div>
      <section class="section"><h2>Schedule</h2>${schedule}</section>
      <section class="section">
        <h2>Sustainability</h2>
        ${meter("⛽ Gas saved by carpooling", carpoolFraction, `${su.gallonsSavedByCarpool} gal · ${money(su.usdSavedByCarpool)}`, `vs. ${su.memberCount} cars driving the same route`)}
        ${meter("🌍 Carbon footprint cut", co2Fraction, `${su.co2KgPerPerson} kg CO₂ each`, `vs. ${su.co2KgPerPersonSolo} kg each driving alone`)}
        ${meter("🌱 Green stops", su.totalStops ? su.greenStops / su.totalStops : 0, `${su.greenStops} of ${su.totalStops}`, "parks, hikes, local food, EV charging")}
      </section>
      <section class="section">
        <h2>Totals</h2>
        <div class="stats">
          <div class="stat"><b>${miles} mi</b><span>${it.routeSource === "osrm" ? "OSRM route" : "estimated route"}</span></div>
          <div class="stat"><b>${fmtDuration(t.driveSeconds)}</b><span>driving</span></div>
          <div class="stat"><b>${money(t.estimatedCostPerPersonUsd)}</b><span>est. per person${t.overBudget ? " ⚠️" : ""}</span></div>
          <div class="stat"><b>${money(t.budgetPerPersonUsd)}</b><span>budget per person</span></div>
        </div>
      </section>
      ${
        d.decisions.length
          ? `<section class="section"><h2>Group decisions</h2><ul class="list">${d.decisions
              .map((x) => `<li>${esc(x.question)} → <b>${esc(x.winningLabel)}</b> (${x.votes}/${x.voters})</li>`)
              .join("")}</ul></section>`
          : ""
      }
      <section class="section"><h2>Crew</h2><ul class="list">${d.members
        .map((m) => `<li>${esc(m.name)}${d.phase === "review" ? (m.approved ? " ✅" : " ⏳") : ""}</li>`)
        .join("")}</ul></section>
      <section class="section"><h2>Legend</h2><div class="legend">${Object.keys(ICONS)
        .map(
          (k) =>
            `<span><span class="orb" style="--pin: var(--k-${k}); width:22px;height:22px;font-size:11px;display:inline-grid;place-items:center;border-radius:50%">${ICONS[k]}</span>${LABELS[k]}</span>`,
        )
        .join("")}</div></section>
      <p class="foot">Assumptions: ${su.vehicleMpg} mpg, ${money(su.gasPriceUsdPerGallon)}/gal, ${su.co2KgPerGallon} kg CO₂/gal (EPA).
        Fuel cost ${money(t.fuelCostPerPersonUsd)}/person + Gemini web estimates ${money(t.webEstimateStopCostPerPersonUsd)}/person.
        ${it.droppedStops.length ? `<br>Couldn't locate: ${esc(it.droppedStops.join(", "))}.` : ""}
        <br>Map data © OpenStreetMap contributors · routing by OSRM · v${it.version}</p>`;

    for (const el of panel.querySelectorAll(".stop")) el.addEventListener("click", () => focusStop(el.dataset.id));
  }

  function render(d) {
    const it = d.itinerary;
    document.title = d.title;
    $("title").textContent = d.title;
    $("subtitle").textContent = it
      ? `${it.startLocation} → ${it.endLocation} · ${it.tripType === "round_trip" ? "round trip" : "one way"}`
      : "";
    const badge = $("badge");
    badge.hidden = false;
    badge.textContent = PHASES[d.phase] ?? d.phase;
    badge.classList.toggle("live", d.phase === "execution");

    $("bubble").innerHTML =
      `<span class="b-car" aria-hidden="true">🚗</span><div class="b-text"><div class="b-title">${esc(
        d.title,
      )}</div><div class="b-line">${it ? nextUpLine(it, currentIndex(it.stops)) : esc(PHASES[d.phase] ?? "")}</div></div>`;

    renderPanel(d);
    if (it) renderMap(it);
  }

  async function load() {
    try {
      const res = await fetch(`/api/trips/${encodeURIComponent(publicId)}`, { cache: "no-store" });
      if (res.status === 404) {
        $("title").textContent = "Trip not found";
        $("panel").innerHTML = `<p class="notice">Open this dashboard from your trip's iMessage card.</p>`;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const signature = JSON.stringify(data);
      if (signature === lastUpdatedAt) return;
      lastUpdatedAt = signature;
      render(data);
    } catch (error) {
      if (!lastUpdatedAt)
        $("panel").innerHTML = `<p class="notice">Couldn't load the trip (${esc(error.message)}). Retrying…</p>`;
    }
  }

  load();
  setInterval(load, 20_000);
})();
