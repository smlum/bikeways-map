// Bikeways map: network on MapLibre, coloured by CAN-BICS class or by a city's own source class.
// All settings come from data/config.json (generated from config/*.yaml).

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const LINE_ID = "network-line";
const HILITE_ID = "network-highlight";

main();

async function main() {
  const cfg = await (await fetch("data/config.json")).json();
  const classes = cfg.classes.classes;
  const palette = cfg.classes.source_palette;
  const byslug = Object.fromEntries(classes.map((c) => [c.slug, c]));
  // mode: "class" | "source"; focus = {cls?, sc, sec?} (see focusExpr)
  const state = { summary: null, city: null, focus: null, mode: "class" };
  const $ = (id) => document.getElementById(id);

  document.title = $("title").textContent = cfg.title;

  const hadViewInUrl = !!location.hash; // read before MapLibre writes its own hash
  const map = new maplibregl.Map({
    container: "map", style: cfg.basemap, hash: true,
    center: cfg.initial_view.center, zoom: cfg.initial_view.zoom,
  });
  map.addControl(new maplibregl.NavigationControl(), "bottom-left");
  window.map = map; // for debugging in devtools

  // --- controls -------------------------------------------------------------
  cfg.sources.forEach((s) => $("source").add(new Option(s.label, s.id)));
  $("source").onchange = () => setSource(cfg.sources.find((s) => s.id === $("source").value));

  // City search: native datalist autocomplete over place names in the current summary.
  const search = $("city-search");
  const placeByName = () => Object.fromEntries(
    Object.entries(state.summary?.places || {}).map(([id, p]) => [p.name.toLowerCase(), id]));
  search.onchange = () => {
    const id = placeByName()[search.value.trim().toLowerCase()];
    if (!id) return;
    setCity(id, { fit: true });
    search.blur();
  };
  search.onfocus = () => search.select();
  search.onblur = () => { const p = state.summary?.places[state.city]; if (p) search.value = p.name; };

  document.querySelectorAll(".seg-toggle button").forEach((b) => (b.onclick = () => {
    state.mode = b.dataset.mode;
    state.focus = null; // switching colour mode clears any highlight
    document.querySelectorAll(".seg-toggle button").forEach((x) =>
      x.setAttribute("aria-pressed", x === b));
    refresh();
  }));

  // --- colour + filter --------------------------------------------------------
  const classColorExpr = ["match", ["get", "class"],
    ...classes.flatMap((c) => [c.slug, c.color]), cfg.classes.unknown.color];

  // Active city's source classes by km, each with a palette colour (overflow -> "other").
  function sourceClasses() {
    const p = state.summary?.places[state.city];
    if (!p) return [];
    const km = new Map(), cls = new Map();
    p.crosswalk.filter((r) => r.in_data).forEach((r) => {
      km.set(r.source_class, (km.get(r.source_class) || 0) + r.km);
      cls.set(r.source_class, [...(cls.get(r.source_class) || []), r.class]);
    });
    return [...km].sort((a, b) => b[1] - a[1]).map(([sc, k], i) => ({
      sc, km: k, classes: cls.get(sc), color: palette.colors[i] ?? palette.other,
    }));
  }

  function sourceColorExpr(list) {
    if (!list.length) return palette.outside;
    return ["case", ["==", ["get", "place"], state.city],
      ["match", ["get", "source_class"], ...list.flatMap((s) => [s.sc, s.color]), palette.other],
      palette.outside];
  }

  // Focus: any of cls/sc/sec; undefined = any value, sec null = no secondary value.
  function focusExpr({ cls, sc, sec }) {
    const e = ["all", ["==", ["get", "place"], state.city]];
    if (sc !== undefined) e.push(["==", ["get", "source_class"], sc]);
    if (cls !== undefined) e.push(["==", ["get", "class"], cls]);
    if (sec === null) e.push(["!", ["has", "source_class_secondary"]]);
    else if (sec !== undefined) e.push(["==", ["get", "source_class_secondary"], sec]);
    return e;
  }

  function applyStyle(list) {
    if (!map.getLayer(LINE_ID)) return;
    const byClass = state.mode === "class";
    map.setPaintProperty(LINE_ID, "line-color", byClass ? classColorExpr : sourceColorExpr(list));
    // Focus dims everything else rather than hiding it, to keep context.
    // Without focus, segments outside the selected city are faded.
    map.setPaintProperty(LINE_ID, "line-opacity", state.focus
      ? ["case", focusExpr(state.focus), 1, 0.12]
      : ["case", ["==", ["get", "place"], state.city ?? ""], 1, cfg.other_city_opacity]);
  }

  // --- legend -----------------------------------------------------------------
  function renderLegend(list) {
    const legend = $("legend");
    legend.innerHTML = "";
    const sameFocus = (f) => state.focus && state.focus.cls === f.cls && state.focus.sc === f.sc
      && state.focus.sec === undefined;
    const row = ({ color, name, sub, km, focus, empty = !km }) => {
      const li = document.createElement("li");
      const active = sameFocus(focus);
      li.innerHTML = `<button class="src-row ${active ? "active" : ""} ${empty ? "empty-row" : ""}"
          ${empty ? "disabled" : ""} title="${empty ? "None in this city" : "Highlight on the map"}">
        <span class="swatch" style="background:${color}"></span>
        <span class="src-name"><span>${showWs(name)}</span><span class="chips">${sub}</span></span>
        <span class="num muted">${empty ? "–" : `${km < 0.1 ? "<0.1" : km < 1 ? km.toFixed(1) : Math.round(km)} km`}</span></button>`;
      li.querySelector("button").onclick = () => setFocus(active ? null : focus);
      legend.append(li);
    };

    if (state.mode === "class") {
      const name = state.summary?.places[state.city]?.name;
      $("legend-title").textContent = name ? `${name} CAN-BICS class` : "CAN-BICS class";
      const kmBy = state.summary?.places[state.city]?.by_class_km || {};
      classes.forEach((c) => row({
        color: c.color, name: c.label, sub: c.comfort.replace("_", "-"), km: kmBy[c.slug],
        focus: { cls: c.slug, sc: undefined, sec: undefined },
      }));
      return;
    }
    const name = state.summary?.places[state.city]?.name;
    $("legend-title").textContent = name ? `${name} source class` : "Source class";
    if (!list.length) {
      legend.innerHTML = `<li class="muted">Search for a city above.</li>`;
      return;
    }
    list.forEach((s) => {
      const chips = [...new Set(s.classes)].map((slug) => {
        const c = byslug[slug] || cfg.classes.unknown;
        return `<span class="chip" title="Assigned to ${esc(c.label)}"><span class="swatch" style="background:${c.color}"></span>${esc(c.label)}</span>`;
      }).join("");
      row({ color: s.color, name: s.sc, sub: `→ ${chips}`, km: s.km, empty: false,
        focus: { cls: undefined, sc: s.sc, sec: undefined } });
    });
    if (list.length > palette.colors.length) {
      legend.insertAdjacentHTML("beforeend",
        `<li class="muted small">Classes beyond the ${palette.colors.length}th share grey.</li>`);
    }
  }

  // --- city profile -----------------------------------------------------------
  function refresh() {
    const list = sourceClasses();
    applyStyle(list);
    renderLegend(list);
    Profile.render($("profile"), {
      data: state.summary?.places[state.city], classes: cfg.classes, focus: state.focus,
      onFocus: setFocus,
    });
  }

  function setFocus(f) { state.focus = f; refresh(); }

  // Keep fitted cities clear of the side panels (desktop) / bottom sheet (mobile).
  function panelPadding() {
    const r = (id) => $(id).getBoundingClientRect();
    if (innerWidth <= 700) return { top: r("panel").bottom + 10, bottom: innerHeight - r("profile").top + 10, left: 20, right: 20 };
    return { top: 40, bottom: 40, left: r("panel").right + 20, right: innerWidth - r("profile").left + 20 };
  }

  // Lock the map to one city. fit = zoom to its extent.
  function setCity(id, { fit = false } = {}) {
    const p = state.summary?.places[id];
    if (!p) return;
    if (fit) map.fitBounds(p.bounds, { padding: panelPadding(), duration: 1200 });
    if (id === state.city) return;
    state.city = id;
    state.focus = null;
    search.value = p.name;
    const url = new URL(location.href);
    url.searchParams.set("city", id);
    history.replaceState(null, "", url);
    refresh();
  }

  async function setSource(src) {
    state.summary = src.summary ? await (await fetch(`data/${src.summary}`)).json() : null;
    $("city-list").innerHTML = Object.values(state.summary?.places || {})
      .map((p) => p.name).sort((a, b) => a.localeCompare(b))
      .map((n) => `<option value="${esc(n)}"></option>`).join("");

    for (const id of [HILITE_ID, LINE_ID]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource("network")) map.removeSource("network");
    map.addSource("network", {
      type: "vector",
      url: `pmtiles://${new URL(`data/${src.tiles}`, location.href)}`,
      attribution: "Statistics Canada, Canadian Cycling Network Database; municipal open data",
    });
    // Insert below the basemap's first symbol layer so labels draw on top.
    const beforeId = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer({
      id: HILITE_ID, type: "line", source: "network", "source-layer": cfg.layer,
      filter: ["==", ["get", "id"], ""],
      paint: {
        "line-color": "#000",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 12, 7, 16, 11],
        "line-opacity": 0.35,
      },
    }, beforeId);
    map.addLayer({
      id: LINE_ID, type: "line", source: "network", "source-layer": cfg.layer,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": classColorExpr,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.5, 16, 5],
      },
    }, beforeId);
    // Initial city: ?city=, else keep current, else config default. Fit only if the URL has no view.
    const wanted = new URLSearchParams(location.search).get("city") || state.city || cfg.initial_city;
    state.city = null;
    setCity(state.summary?.places[wanted] ? wanted : Object.keys(state.summary?.places || {})[0],
      { fit: !hadViewInUrl });
  }

  // --- interaction ----------------------------------------------------------
  // Query a small box around the pointer so thin lines are easy to hit.
  const HIT_PX = 6;
  const featureAt = (pt) => map.getLayer(LINE_ID) && map.queryRenderedFeatures(
    [[pt.x - HIT_PX, pt.y - HIT_PX], [pt.x + HIT_PX, pt.y + HIT_PX]], { layers: [LINE_ID] })[0];

  const clearHighlight = () => map.getLayer(HILITE_ID) && map.setFilter(HILITE_ID, ["==", ["get", "id"], ""]);
  const popup = new maplibregl.Popup({ maxWidth: "320px", closeOnClick: false });
  popup.on("close", clearHighlight); // note: .on() returns a subscription in v5, not the popup

  map.on("mousemove", (e) => (map.getCanvas().style.cursor = featureAt(e.point) ? "pointer" : ""));

  map.on("click", (e) => {
    const f = featureAt(e.point);
    if (!f) return popup.remove();
    const p = f.properties;
    if (p.place !== state.city) setCity(p.place); // clicking another city's segment switches to it
    const c = byslug[p.class] || { ...cfg.classes.unknown, label: p.class ?? "Unknown" };
    const isEmpty = (v) => v === undefined || v === null || v === "";
    const rows = cfg.popup
      .filter((k) => k.show_empty || !isEmpty(p[k.key]))
      .map((k) => `<tr><th>${k.label}</th><td>${isEmpty(p[k.key])
        ? '<span class="empty">not recorded</span>' : esc(p[k.key])}</td></tr>`).join("");
    const snap = nearestOnLine(map, f.geometry, e.point);
    const links = (cfg.links || []).map((l) => {
      const url = l.url.replace("{lat}", snap.lat.toFixed(6)).replace("{lng}", snap.lng.toFixed(6))
        .replace("{heading}", Math.round(snap.heading));
      return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`;
    }).join("");
    popup.setLngLat(e.lngLat).setHTML(
      `<div class="popup"><h3><span class="swatch" style="background:${c.color}"></span>${esc(c.label)}</h3>
       <table>${rows}</table>${links ? `<div class="links">${links}</div>` : ""}</div>`);
    if (!popup.isOpen()) popup.addTo(map);
    map.setFilter(HILITE_ID, ["==", ["get", "id"], p.id]);
  });

  map.on("load", () => setSource(cfg.sources[0]));
}
// Closest point on a (Multi)LineString to a screen point, plus the bearing of that sub-segment.
function nearestOnLine(map, geom, pt) {
  const lines = geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
  let best = { d: Infinity };
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = map.project(line[i]), b = map.project(line[i + 1]);
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2)) : 0;
      const x = a.x + t * dx, y = a.y + t * dy, d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < best.d) best = { d, x, y, a: line[i], b: line[i + 1] };
    }
  }
  const { lng, lat } = map.unproject([best.x, best.y]);
  return { lng, lat, heading: bearing(best.a, best.b) };
}

function bearing([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

// Escape, and make leading/trailing whitespace visible (source values are shown as-is).
function showWs(v) {
  const str = String(v ?? "");
  const m = str.match(/^(\s*)(.*?)(\s*)$/s);
  const mark = (w) => w ? `<span class="ws" title="whitespace in source value">${"␣".repeat(w.length)}</span>` : "";
  return mark(m[1]) + esc(m[2]) + mark(m[3]);
}

function esc(v) {
  return String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}
