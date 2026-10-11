// Trip dashboard (Photon mini-app). Reads GET /api/trips/:publicId (TripDashboard schema) and renders four
// touch-sized tabs — Map (OpenStreetMap/Leaflet), Schedule, Impact (sustainability energy bars), Trip.
// Only the active tab scrolls, and only vertically. Refreshes every 20 s.
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
  const TABS = ["map", "schedule", "impact", "trip"];
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
  let lastSignature = null;
  let fitted = false;
  let current = null;
  let activeTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "map";

  // --- layout: the in-thread live bubble is tiny, so it only gets a one-line summary ------------------
  function applyMode() {
    document.body.classList.toggle("bubble", window.innerHeight < 120);
  }
  window.addEventListener("resize", () => {
    applyMode();
    map?.invalidateSize();
  });
  applyMode();

  // --- tabs -------------------------------------------------------------------------------------------
  function showTab(name) {
    activeTab = name;
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
      $(`pane-${t}`).classList.toggle("active", t === name);
    }
    try {
      history.replaceState(null, "", `#${name}`);
    } catch {}
    if (name === "map" && current?.itinerary) {
      ensureMap();
      // the map container was display:none until now
      requestAnimationFrame(() => {
        map?.invalidateSize();
        renderMap(current.itinerary);
      });
    }
  }
  for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => showTab(t));

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

  // --- map --------------------------------------------------------------------------------------------
  function ensureMap() {
    if (map || typeof L === "undefined") return;
    map = L.map("map", {
      zoomControl: false,
      scrollWheelZoom: false,
      attributionControl: true,
      zoomSnap: 0.25, // a west–east route in a tall phone map fits far better at fractional zoom
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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
      <p><b>${esc(time)}</b></p>
      ${s.address ? `<p>${esc(s.address)}</p>` : ""}
      ${s.note ? `<p>${esc(s.note)}</p>` : ""}
      ${s.webEstimateCostPerPersonUsd != null ? `<p>≈ ${money(s.webEstimateCostPerPersonUsd)}/person <span class="tag">Gemini web estimate</span></p>` : ""}
      <a class="gmaps" href="${gmaps(s)}" target="_blank" rel="noopener">Open in Google Maps</a>
    </div>`;
  }

  function renderMap(it) {
    ensureMap();
    if (!map || $("pane-map").offsetParent === null) return; // hidden tab: render when shown
    layer.clearLayers();
    markers = new Map();
    const done = currentIndex(it.stops);
    for (const leg of it.legs) {
      if (leg.geometry.length < 2) continue;
      L.polyline(leg.geometry, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(layer);
      L.polyline(leg.geometry, {
        color: "#16a5d8",
        weight: 4.5,
        opacity: 0.95,
        dashArray: leg.source === "estimate" ? "8 8" : null,
      }).addTo(layer);
    }
    it.stops.forEach((s, i) => {
      const classes = ["pin", s.geocodeSource === "approximate" ? "approx" : "", i <= done ? "done" : ""].join(" ");
      const icon = L.divIcon({
        className: "",
        html: `<div class="${classes}" style="--pin: var(--k-${s.kind})"><span>${ICONS[s.kind]}</span><span class="n">${i + 1}</span></div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18],
      });
      const marker = L.marker([s.latLng.lat, s.latLng.lng], { icon, title: s.name, riseOnHover: true })
        .bindTooltip(`<b>${esc(s.name)}</b><br>${esc(fmtTime(s.arriveAt ?? s.departAt, it.timeZone))}`, {
          direction: "top",
          offset: [0, -18],
        })
        .bindPopup(popupHtml(s, it), { maxWidth: 240, autoPanPadding: [16, 56] })
        .addTo(layer);
      markers.set(s.id, marker);
    });
    if (!fitted && it.stops.length) {
      map.fitBounds(L.latLngBounds(it.stops.map((s) => [s.latLng.lat, s.latLng.lng])), {
        paddingTopLeft: [24, 60], // keep pins clear of the "Next" chip
        paddingBottomRight: [24, 24],
      });
      fitted = true;
    }
    const chip = $("map-chip");
    chip.innerHTML = nextUpLine(it, done);
    chip.hidden = !chip.innerHTML;
  }

  /** Schedule tap → switch to the map, fly to the stop, open its popup. */
  function focusStop(id) {
    showTab("map");
    setTimeout(() => {
      const marker = markers.get(id);
      if (!marker || !map) return;
      map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.6 });
      setTimeout(() => marker.openPopup(), 650);
    }, 60);
  }

  // --- panes ------------------------------------------------------------------------------------------
  function meter(title, fraction, value, unit, hint) {
    const f = Math.max(0, Math.min(1, fraction || 0));
    const cells = Array.from({ length: 10 }, (_, i) => {
      const fill = f * 10 - i;
      return `<div class="cell${fill >= 1 ? " on" : fill > 0.25 ? " half" : ""}"></div>`;
    }).join("");
    return `<div class="meter" role="img" aria-label="${esc(`${title}: ${value} ${unit}`)}">
      <div class="label">${esc(title)}</div>
      <div class="value">${esc(value)} <small>${esc(unit)}</small></div>
      <div class="cells">${cells}</div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ""}
    </div>`;
  }

  function renderSchedule(it) {
    const tz = it.timeZone;
    const idx = currentIndex(it.stops);
    let html = `<div class="next-up">${nextUpLine(it, idx)}</div><h2>Schedule</h2>`;
    let day = 0;
    it.stops.forEach((s, i) => {
      if (s.day !== day) {
        day = s.day;
        const when = s.departAt ?? s.arriveAt;
        html += `<div class="day">Day ${day}${when ? ` · ${esc(fmtDate(when, tz))}` : ""}</div>`;
      }
      const meta = [
        LABELS[s.kind],
        s.dwellMinutes && s.kind !== "lodging" && s.arriveAt && s.departAt ? `${s.dwellMinutes} min` : "",
        s.geocodeSource === "approximate" ? "approx." : "",
        s.sustainable ? "🌱" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      html += `<button class="stop${i <= idx ? " done" : ""}" data-id="${esc(s.id)}" type="button">
        <span class="time">${esc(fmtTime(s.arriveAt ?? s.departAt, tz))}</span>
        <span class="orb" style="--pin: var(--k-${s.kind})" aria-hidden="true">${ICONS[s.kind]}</span>
        <span class="info"><span class="name">${esc(s.name)}</span><span class="meta">${esc(meta)}</span></span>
        <span class="chev" aria-hidden="true">›</span>
      </button>`;
    });
    const pane = $("pane-schedule");
    pane.innerHTML = html;
    for (const el of pane.querySelectorAll(".stop")) el.addEventListener("click", () => focusStop(el.dataset.id));
  }

  function renderImpact(it) {
    const su = it.sustainability;
    const t = it.totals;
    const miles = Math.round(t.distanceMeters / METERS_PER_MILE);
    const carpool = su.soloFuelGallons ? su.gallonsSavedByCarpool / su.soloFuelGallons : 0;
    const co2Cut = su.co2KgPerPersonSolo ? 1 - su.co2KgPerPerson / su.co2KgPerPersonSolo : 0;
    $("pane-impact").innerHTML = `
      <h2>Sustainability</h2>
      ${meter("⛽ Gas saved by carpooling", carpool, `${su.gallonsSavedByCarpool} gal`, `· ${money(su.usdSavedByCarpool)} saved`, `vs. ${su.memberCount} cars driving the same route`)}
      ${meter("🌍 Carbon footprint cut", co2Cut, `${su.co2KgPerPerson} kg`, "CO₂ each", `vs. ${su.co2KgPerPersonSolo} kg each driving alone`)}
      ${meter("🌱 Green stops", su.totalStops ? su.greenStops / su.totalStops : 0, `${su.greenStops} of ${su.totalStops}`, "stops", "parks, hikes, local food, EV charging")}
      <h2>Totals</h2>
      <div class="stats">
        <div class="stat"><b>${miles} mi</b><span>${it.routeSource === "osrm" ? "routed (OSRM)" : "estimated"}</span></div>
        <div class="stat"><b>${fmtDuration(t.driveSeconds)}</b><span>driving</span></div>
        <div class="stat"><b>${money(t.estimatedCostPerPersonUsd)}</b><span>est. per person${t.overBudget ? " ⚠️" : ""}</span></div>
        <div class="stat"><b>${money(t.budgetPerPersonUsd)}</b><span>budget per person</span></div>
      </div>
      <p class="foot">Assumptions: ${su.vehicleMpg} mpg, ${money(su.gasPriceUsdPerGallon)}/gal, ${su.co2KgPerGallon} kg CO₂/gal (EPA).
        Fuel ${money(t.fuelCostPerPersonUsd)}/person + Gemini web estimates ${money(t.webEstimateStopCostPerPersonUsd)}/person.</p>`;
  }

  function renderTrip(d) {
    const it = d.itinerary;
    $("pane-trip").innerHTML = `
      <h2>Crew</h2>
      <ul class="list">${d.members
        .map((m) => `<li>${esc(m.name)}${d.phase === "review" ? (m.approved ? " ✅" : " ⏳") : ""}</li>`)
        .join("")}</ul>
      ${
        d.decisions.length
          ? `<h2>Group decisions</h2><ul class="list">${d.decisions
              .map((x) => `<li>${esc(x.question)} → <b>${esc(x.winningLabel)}</b> (${x.votes}/${x.voters})</li>`)
              .join("")}</ul>`
          : ""
      }
      <h2>Legend</h2>
      <div class="legend">${Object.keys(ICONS)
        .map((k) => `<span><span class="orb" style="--pin: var(--k-${k})">${ICONS[k]}</span>${LABELS[k]}</span>`)
        .join("")}</div>
      <p class="foot">${it?.droppedStops.length ? `Couldn't locate: ${esc(it.droppedStops.join(", "))}.<br>` : ""}
        Map data © OpenStreetMap contributors · routing by OSRM${it ? ` · itinerary v${it.version}` : ""}</p>
      <a class="btn-link" href="${esc(location.href.split("#")[0])}" target="_blank" rel="noopener">Open full screen ↗</a>`;
  }

  function render(d) {
    current = d;
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

    if (!it) {
      const msg = `<p class="notice">${esc(PHASES[d.phase] ?? d.phase)} — the itinerary appears here once it's drafted.</p>`;
      $("pane-schedule").innerHTML = msg;
      $("pane-impact").innerHTML = msg;
      renderTrip(d);
      if (activeTab === "map") showTab("schedule");
      return;
    }
    renderSchedule(it);
    renderImpact(it);
    renderTrip(d);
    if (activeTab === "map") renderMap(it);
  }

  async function load() {
    try {
      const res = await fetch(`/api/trips/${encodeURIComponent(publicId)}`, { cache: "no-store" });
      if (res.status === 404) {
        $("title").textContent = "Trip not found";
        $("pane-schedule").innerHTML = `<p class="notice">Open this dashboard from your trip's iMessage card.</p>`;
        showTab("schedule");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const signature = JSON.stringify(data);
      if (signature === lastSignature) return;
      lastSignature = signature;
      render(data);
    } catch (error) {
      if (!lastSignature)
        $("pane-schedule").innerHTML =
          `<p class="notice">Couldn't load the trip (${esc(error.message)}). Retrying…</p>`;
    }
  }

  showTab(activeTab);
  load();
  setInterval(load, 20_000);
})();
