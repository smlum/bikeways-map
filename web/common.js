// Shared pieces for the map pages: config, network layers, popup, city search, helpers.
// Plain script (no build step); exposes globals.

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

async function loadConfig() {
  return (await fetch("data/config.json")).json();
}

async function loadSummary(src) {
  return src.summary ? withAll(await (await fetch(`data/${src.summary}`)).json()) : null;
}

// Pseudo-place ALL: the sum of every place, selectable like a city ("All 75 cities").
const ALL = "all";
const realPlaces = (places) => Object.entries(places || {}).filter(([id]) => id !== ALL);
function withAll(summary) {
  const ps = realPlaces(summary.places).map(([, p]) => p);
  if (!ps.length) return summary;
  const add = (key) => ps.reduce((m, p) => {
    for (const [k, v] of Object.entries(p[key] || {})) m[k] = (m[k] || 0) + v;
    return m;
  }, {});
  const all = { name: `All ${ps.length} cities`, all: true, crosswalk: [], provenance: {} };
  if (ps[0].by_class_km) { // dataset summary
    Object.assign(all, { by_class_km: add("by_class_km"), total_km: ps.reduce((t, p) => t + (p.total_km || 0), 0),
      bounds: [0, 1, 2, 3].map((i) => (i < 2 ? Math.min : Math.max)(...ps.map((p) => p.bounds[i]))) });
  } else { // comparison summary: concatenate each side's rows
    Object.assign(all, { a: ps.flatMap((p) => p.a || []), b: ps.flatMap((p) => p.b || []) });
  }
  summary.places = { [ALL]: all, ...summary.places };
  return summary;
}

// k: optional colour transform (e.g. c => fade(c, 0.15)).
function classColorExpr(cfg, k = (c) => c) {
  return ["match", ["get", "class"],
    ...cfg.classes.classes.flatMap((c) => [c.slug, k(c.color)]), k(cfg.classes.unknown.color)];
}

// A colour as it looks at opacity `a` over the light basemap, as an opaque hex (overlaps don't stack).
const BASEMAP_BG = [242, 243, 240]; // positron background
function fade(hex, a) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return "#" + rgb.map((v, i) => Math.round(v * a + BASEMAP_BG[i] * (1 - a)).toString(16).padStart(2, "0")).join("");
}

function classInfo(cfg, slug) {
  return cfg.classes.classes.find((c) => c.slug === slug)
    || { ...cfg.classes.unknown, slug, label: slug ?? "Unknown" };
}

function getParam(k) { return new URLSearchParams(location.search).get(k); }
function setParam(k, v) {
  const u = new URL(location.href);
  if (v == null) u.searchParams.delete(k);
  else u.searchParams.set(k, v);
  history.replaceState(null, "", u);
}

/**
 * One network (PMTiles) shown on a map, with a highlight layer, hover cursor and click popup.
 *   const net = new Network(map, cfg, { onClick: (props) => ... });
 *   net.setSource(src); net.setPaint(color, opacity);
 */
class Network {
  // interactive(props): which segments respond to hover/click (default all).
  // popupTitle(props) / popupLead(props): override the popup's heading / add <tr> rows above the fields.
  // popupAction(props, vars): html for a button row at the bottom (vars: lat, lng, heading of the click).
  constructor(map, cfg, { onClick, popupTitle, popupLead, popupAction, interactive = () => true } = {}) {
    this.map = map;
    this.cfg = cfg;
    this.popupAction = popupAction;
    this.popupTitle = popupTitle;
    this.popupLead = popupLead;
    this.src = null;
    this.lineId = "network-line";
    this.hiliteId = "network-highlight";
    this.popup = new maplibregl.Popup({ maxWidth: "320px", closeOnClick: false });
    this.popup.on("close", () => this.highlight(null)); // .on() returns a subscription in v5

    this.featureAt = (pt) => lineAt(map, pt, this.lineId, interactive);

    map.on("mousemove", (e) => (map.getCanvas().style.cursor = this.featureAt(e.point) ? "pointer" : ""));
    map.on("click", (e) => {
      const f = this.featureAt(e.point);
      if (!f) return this.popup.remove();
      onClick?.(f.properties);
      this.showPopup(f, e);
    });
  }

  // src: a manifest source (or comparison) entry; layer: tile layer name (default cfg.layer).
  setSource(src, { layer = this.cfg.layer } = {}) {
    const { map, cfg } = this;
    this.src = src;
    this.popup.remove();
    for (const id of [this.hiliteId, this.lineId]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource("network")) map.removeSource("network");
    map.addSource("network", {
      type: "vector",
      url: `pmtiles://${new URL(`data/${src.tiles}`, location.href)}`,
      attribution: src.attribution,
    });
    // Insert below the basemap's first symbol layer so labels draw on top.
    const beforeId = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer({
      id: this.hiliteId, type: "line", source: "network", "source-layer": layer,
      filter: ["==", ["get", "id"], ""],
      paint: {
        "line-color": "#000",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 12, 7, 16, 11],
        "line-opacity": 0.35,
      },
    }, beforeId);
    map.addLayer({
      id: this.lineId, type: "line", source: "network", "source-layer": layer,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": classColorExpr(cfg),
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.5, 16, 5],
      },
    }, beforeId);
  }

  // sortKey: higher draws on top.
  setPaint(color, opacity, sortKey) {
    if (!this.map.getLayer(this.lineId)) return;
    this.map.setPaintProperty(this.lineId, "line-color", color);
    this.map.setPaintProperty(this.lineId, "line-opacity", opacity);
    if (sortKey !== undefined) this.map.setLayoutProperty(this.lineId, "line-sort-key", sortKey);
  }

  highlight(id) {
    if (this.map.getLayer(this.hiliteId)) this.map.setFilter(this.hiliteId, ["==", ["get", "id"], id ?? ""]);
  }

  showPopup(f, e) {
    const p = f.properties;
    this.popup.setLngLat(e.lngLat).setHTML(segmentPopup(this.map, this.cfg, f, e, {
      fields: this.src?.fields, snapshot: this.src?.osm_snapshot, title: this.popupTitle?.(p), lead: this.popupLead?.(p),
      action: this.popupAction }));
    if (!this.popup.isOpen()) this.popup.addTo(this.map);
    wireOsmTags(this.popup.getElement());
    this.highlight(p.id);
  }
}

/**
 * Popup html for one clicked segment: heading (default: class swatch + label), `lead` rows, the
 * web.yaml popup fields the dataset has (`fields`), and web.yaml links ({lat},{lng},{heading} = the
 * point on the segment nearest the click).
 */
function segmentPopup(map, cfg, f, e, { fields = [], snapshot, title, lead = "", action } = {}) {
  const p = f.properties;
  const c = classInfo(cfg, p.class);
  const isEmpty = (v) => v === undefined || v === null || v === "";
  const have = new Set(fields);
  // Can-BICS OSM: source_class is just the Can-BICS name; only worth showing where it differs
  // from our label (the non-conforming ones).
  const osm = have.has("osm_id");
  const redundant = (k) => osm && k.key === "source_class" && String(p[k.key]).toLowerCase() === c.label.toLowerCase();
  const rows = cfg.popup
    .filter((k) => have.has(k.key) && !redundant(k))
    .filter((k) => k.show_empty || !isEmpty(p[k.key]))
    .map((k) => `<tr><th>${k.label}</th><td>${isEmpty(p[k.key])
      ? '<span class="empty">not recorded</span>' : showWs(p[k.key])}</td></tr>`).join("");
  const snap = nearestOnLine(map, f.geometry, e.point);
  const vars = { ...p, lat: snap.lat.toFixed(6), lng: snap.lng.toFixed(6), heading: Math.round(snap.heading) };
  const links = (cfg.links || []).filter((l) => !l.requires || !isEmpty(p[l.requires])).map((l) => {
    const url = l.url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`;
  }).join("");
  const head = title ?? `<span class="swatch" style="background:${c.color}"></span>${esc(c.label)}`;
  const tags = osm && snapshot && !isEmpty(p.osm_id) ? `<div class="osm-tags" data-osm-id="${esc(p.osm_id)}" data-snapshot="${esc(snapshot)}">
    <button class="osm-load">Show OSM tags (${esc(snapshot)})</button></div>` : "";
  const act = action?.(p, vars) || "";
  return `<div class="popup"><h3>${head}</h3><table>${lead}${rows}</table>${tags}${links ? `<div class="links">${links}</div>` : ""}${act}</div>`;
}

/**
 * "Show OSM tags" button in a popup (.osm-tags): on click only, fetches the way's history from the
 * OpenStreetMap API and shows its cycling-related tags as of the dataset's snapshot date, i.e. what
 * the classification saw (the dataset itself doesn't carry the tags).
 */
const OSM_TAG_RE = /^(highway|cycleway(:.*)?|bicycle(:.*)?|bicycle_road|cyclestreet|segregated|foot|footway|path|surface|smoothness|width|oneway(:bicycle)?|lanes|maxspeed|motor_vehicle|access|traffic_calming|sidewalk(:.*)?:bicycle)$/;
const osmCache = new Map();
function wireOsmTags(root) {
  const box = root?.querySelector(".osm-tags[data-osm-id]");
  box?.querySelector(".osm-load")?.addEventListener("click", () => showOsmTags(box));
}
async function showOsmTags(box) {
  const { osmId: id, snapshot } = box.dataset;
  box.innerHTML = `<span class="muted">Loading…</span>`;
  try {
    if (!osmCache.has(id)) {
      osmCache.set(id, fetch(`https://api.openstreetmap.org/api/0.6/way/${encodeURIComponent(id)}/history.json`)
        .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))));
    }
    const versions = (await osmCache.get(id)).elements;
    const at = versions.filter((v) => v.timestamp.slice(0, 10) <= snapshot).at(-1);
    if (!at) {
      box.innerHTML = `<span class="muted">Way created after ${esc(snapshot)}</span>`;
      return;
    }
    const tags = Object.entries(at.tags || {}).filter(([k]) => OSM_TAG_RE.test(k)).sort(([a], [b]) => a.localeCompare(b));
    box.innerHTML = `<div class="osm-head">OSM tags at ${esc(snapshot)}</div>
      ${tags.length ? `<code>${tags.map(([k, v]) => `${esc(k)}=${esc(v)}`).join("<br>")}</code>` : `<span class="muted">no cycling tags</span>`}`;
  } catch (err) {
    osmCache.delete(id);
    box.innerHTML = `<span class="muted">OSM tags unavailable (${esc(err)})</span>`;
  }
}

// City search: a text box with its own suggestion list (not the browser's datalist, which can only
// match the exact text it shows). Matching ignores accents and case ("montreal" finds Montréal) and
// names always show as spelled. Names starting with the text come first. Arrow keys move, Enter
// picks (the top match by default), Esc leaves. Empties on focus (current city stays as placeholder)
// so you can just type; restores on blur.
function citySearch(input, list, { getPlaces, getCurrent, onPick }) {
  let names = []; // [{id, name}], All cities first
  let matches = [], active = -1;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-autocomplete", "list");

  function render() {
    const q = fold(input.value.trim());
    const starts = [], contains = [];
    for (const p of names) {
      const n = fold(p.name);
      if (!q || n.startsWith(q)) starts.push(p);
      else if (n.includes(q)) contains.push(p);
    }
    matches = [...starts, ...contains];
    active = Math.min(active, matches.length - 1);
    list.innerHTML = matches.map((p, i) => `<li role="option" data-id="${esc(p.id)}"
      ${i === active ? `class="active" aria-selected="true"` : ""}>${esc(p.name)}</li>`).join("");
    list.hidden = !matches.length || document.activeElement !== input;
    input.setAttribute("aria-expanded", String(!list.hidden));
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }
  function pick(id) {
    if (!id) return;
    list.hidden = true;
    onPick(id);
    input.blur();
  }

  input.oninput = () => { active = input.value.trim() ? 0 : -1; render(); };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!matches.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(matches[active]?.id ?? names.find((p) => fold(p.name) === fold(input.value.trim()))?.id);
    } else if (e.key === "Escape") {
      input.blur();
    }
  };
  // mousedown, not click: picking must happen before the box loses focus (which hides the list).
  list.onmousedown = (e) => {
    e.preventDefault();
    pick(e.target.closest("li")?.dataset.id);
  };
  input.onfocus = () => {
    input.placeholder = input.value || "Search a city…";
    input.value = "";
    active = -1;
    render();
  };
  input.onblur = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    const p = (getPlaces() || {})[getCurrent()];
    if (p) input.value = p.name;
    input.placeholder = "Search a city…";
  };
  return {
    setOptions(places) {
      names = realPlaces(places).map(([id, p]) => ({ id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
      if (places?.[ALL]) names.unshift({ id: ALL, name: places[ALL].name });
    },
    show(name) { if (document.activeElement !== input) input.value = name; },
  };
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
  return String(v ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

// km of CAN-BICS infrastructure: all classes except non-conforming ones (gravel trail, shared roadways).
function canbicsKm(place, classes) {
  return classes.filter((c) => c.comfort !== "non_conforming")
    .reduce((t, c) => t + (place.by_class_km[c.slug] || 0), 0);
}

// The first line of `layer` near a screen point (passing `keep(props)`, if given). Queries a box around
// the pointer so thin lines are easy to hover and click; use it for every clickable line layer.
const HIT_PX = 6;
function lineAt(map, pt, layer, keep = () => true) {
  if (!map.getLayer(layer)) return undefined;
  return map.queryRenderedFeatures([[pt.x - HIT_PX, pt.y - HIT_PX], [pt.x + HIT_PX, pt.y + HIT_PX]], { layers: [layer] })
    .find((f) => keep(f.properties));
}

// Lowercase text without accents ("Québec" -> "quebec"), for accent-blind matching.
const fold = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Divider above the non-conforming classes: a checkbox that shows/hides them, with their total km.
// The caller wires the change event on `.nc-divider input`.
function ncDivider(on, kmHtml, title = "") {
  return `<li class="divider nc-divider"><label title="${esc(title)}"><input type="checkbox" ${on ? "checked" : ""}>
    Non-conforming</label><span class="num">${kmHtml}</span></li>`;
}

function fmtKm(km) {
  if (!km) return "–";
  return km < 0.1 ? "<0.1" : km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString();
}

/**
 * Profile areas (data/areas.geojson). Every place's outer boundary is drawn faintly so it can be found
 * and clicked; the selected place gets a dashed outline plus its CSDs (thin), and areas.hover(id)
 * lights up another place under the pointer. Drawn under the network.
 *   areas.setPlace(id); areas.hover(id | null); areas.placeAt(point) -> place id | undefined
 */
function addAreas(map, beforeId) {
  map.addSource("areas", { type: "geojson", data: "data/areas.geojson" });
  const none = ["==", ["get", "place"], ""];
  const isArea = ["==", ["get", "kind"], "area"];
  map.addLayer({ id: "area-all", type: "fill", source: "areas", filter: isArea,
    paint: { "fill-color": "#1d1d1f", "fill-opacity": 0.015 } }, beforeId);
  map.addLayer({ id: "area-all-line", type: "line", source: "areas", filter: isArea,
    paint: { "line-color": "#8a8a8f", "line-width": 0.75, "line-opacity": 0.5 } }, beforeId);
  map.addLayer({ id: "area-hover", type: "fill", source: "areas", filter: none,
    paint: { "fill-color": "#1d1d1f", "fill-opacity": 0.04 } }, beforeId);
  map.addLayer({ id: "area-hover-line", type: "line", source: "areas", filter: none,
    paint: { "line-color": "#1d1d1f", "line-width": 1, "line-opacity": 0.45 } }, beforeId);
  map.addLayer({ id: "area-fill", type: "fill", source: "areas", filter: none,
    paint: { "fill-color": "#1d1d1f", "fill-opacity": 0.03 } }, beforeId);
  map.addLayer({ id: "area-csd", type: "line", source: "areas", filter: none,
    paint: { "line-color": "#6e6e73", "line-width": 0.75, "line-opacity": 0.6 } }, beforeId);
  map.addLayer({ id: "area-outline", type: "line", source: "areas", filter: none,
    paint: { "line-color": "#1d1d1f", "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.7 } }, beforeId);
  const of = (id, kind) => ["all", ["==", ["get", "place"], id ?? ""], ["==", ["get", "kind"], kind]];
  return {
    setPlace(id) {
      map.setFilter("area-fill", of(id, "area"));
      map.setFilter("area-csd", of(id, "csd"));
      map.setFilter("area-outline", of(id, "area"));
    },
    hover(id) {
      map.setFilter("area-hover", of(id, "area"));
      map.setFilter("area-hover-line", of(id, "area"));
    },
    placeAt(pt) { return map.queryRenderedFeatures(pt, { layers: ["area-all"] })[0]?.properties.place; },
  };
}
