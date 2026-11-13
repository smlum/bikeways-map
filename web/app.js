// Bikeways map: CCND network on MapLibre, coloured by CAN-BICS class.
// All settings come from data/config.json (generated from config/*.yaml).

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const LINE_ID = "network-line";
const HILITE_ID = "network-highlight";

main();

async function main() {
  const cfg = await (await fetch("data/config.json")).json();
  const classes = cfg.classes.classes;
  const byslug = Object.fromEntries(classes.map((c) => [c.slug, c]));
  const hidden = new Set();

  document.title = document.getElementById("title").textContent = cfg.title;

  const map = new maplibregl.Map({
    container: "map",
    style: cfg.basemap,
    center: cfg.cities[0].center,
    zoom: cfg.cities[0].zoom,
    hash: true,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  window.map = map; // for debugging in devtools

  // --- controls -------------------------------------------------------------
  const sel = document.getElementById("source");
  cfg.sources.forEach((s) => sel.add(new Option(s.label, s.id)));
  sel.onchange = () => setSource(cfg.sources.find((s) => s.id === sel.value));

  const cities = document.getElementById("cities");
  cfg.cities.forEach((c) => {
    const b = document.createElement("button");
    b.textContent = c.name;
    b.onclick = () => map.flyTo({ center: c.center, zoom: c.zoom });
    cities.append(b);
  });

  const legend = document.getElementById("legend");
  classes.forEach((c) => {
    const li = document.createElement("li");
    li.innerHTML = `<label><input type="checkbox" checked>
      <span class="swatch" style="background:${c.color}"></span>${c.label}
      <span class="comfort">${c.comfort.replace("_", "-")}</span></label>`;
    li.querySelector("input").onchange = (e) => {
      e.target.checked ? hidden.delete(c.slug) : hidden.add(c.slug);
      applyFilter();
    };
    legend.append(li);
  });

  // --- layers ---------------------------------------------------------------
  const colorExpr = ["match", ["get", "class"],
    ...classes.flatMap((c) => [c.slug, c.color]), cfg.classes.unknown.color];

  function applyFilter() {
    const f = hidden.size ? ["!", ["in", ["get", "class"], ["literal", [...hidden]]]] : null;
    map.setFilter(LINE_ID, f);
  }

  function setSource(src) {
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
        "line-color": colorExpr,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.5, 16, 5],
      },
    }, beforeId);
    applyFilter();
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
    const c = byslug[p.class] || { ...cfg.classes.unknown, label: p.class ?? "Unknown" };
    const rows = cfg.popup
      .filter((k) => p[k.key] !== undefined && p[k.key] !== null && p[k.key] !== "")
      .map((k) => `<tr><th>${k.label}</th><td>${esc(p[k.key])}</td></tr>`).join("");
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

function esc(v) {
  return String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}
