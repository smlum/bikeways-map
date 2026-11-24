// Map page: one network, coloured by CAN-BICS class, or (compare mode) by how it matches the other
// dataset of web.yaml compare_key, with that dataset drawn behind. The view tabs (config/web.yaml views)
// pick dataset + colour mode together. One side panel: controls on top, city info (profile.js) below.
// All settings come from data/config.json (generated from config/*.yaml). Shared code: common.js.

main();

async function main() {
  const cfg = await loadConfig();
  const classes = cfg.classes.classes;
  // mode: "class" | "compare"; focus = {cls} or {sc} (see focusExpr); showSc: list source classes
  // cmpFocus (compare mode): see cmpFocusExpr. includeNC (compare): show non-conforming-only stretches.
  // showNC (class tabs): draw the non-conforming classes.
  const state = { source: null, summary: null, city: null, focus: null, mode: "class",
    cmpSummary: null, summaryB: null, cmpFocus: null, includeNC: false, showNC: true, view: null, showSc: false,
    table: getParam("panel") === "table", q: "",
    // Issues: list (from the local issues API when serve.py runs, else config.json), draft = the
    // new-issue form, issueSel = selected issue id.
    issues: cfg.issues || [], api: false, draft: null, issueSel: null, issueError: null,
    issuesOpen: (() => { try { return localStorage.getItem("issuesOpen") !== "0"; } catch { return true; } })() };
  const $ = (id) => document.getElementById(id);

  document.title = $("title").textContent = cfg.title;

  const hadViewInUrl = !!location.hash; // read before MapLibre writes its own hash
  const map = new maplibregl.Map({
    container: "map", style: cfg.basemap, hash: true,
    center: cfg.initial_view.center, zoom: cfg.initial_view.zoom, maxBounds: cfg.max_bounds, minZoom: cfg.min_zoom,
  });
  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  window.map = map; // for debugging in devtools
  // Only the selected city's segments are clickable; elsewhere a click picks the city (see below).
  // In compare mode the popup reads "<a> says … / <b> says …" (see cmpTitle, matchRows).
  const net = new Network(map, cfg, {
    interactive: (p) => (state.city === ALL || p.place === state.city) && !ncHidden(p),
    popupTitle: (p) => state.mode === "compare" ? cmpTitle(p) : undefined,
    popupLead: (p) => state.mode === "compare" ? matchRows(p) : "",
    popupAction: (p, vars) => issueButton(p, vars, state.mode === "compare" ? "cmp" : state.source?.id === ck?.b ? "b" : "a"),
  });

  // --- controls -------------------------------------------------------------
  // Each "view" tab picks a dataset and a colour mode (config/web.yaml views).
  const views = cfg.views.filter((v) => cfg.sources.some((s) => s.id === v.source));
  views.forEach((v) => {
    const b = document.createElement("button");
    b.textContent = v.label;
    b.dataset.view = v.id;
    b.onclick = () => setView(v);
    $("views").append(b);
  });
  let firstLoad = true;
  let areas = null;

  const search = citySearch($("city-search"), $("city-list"), {
    getPlaces: () => state.summary?.places, getCurrent: () => state.city,
    onPick: (id) => setCity(id, { fit: !state.table }),
    filtering: () => state.table,
    onFilter: (q) => { state.q = q; renderTable(); },
  });

  function setView(v) {
    const wasCompare = state.mode === "compare";
    state.mode = v.mode;
    state.view = v;
    state.focus = state.cmpFocus = null; // switching view clears any highlight
    setParam("view", v.id);
    $("views").querySelectorAll("button").forEach((x) =>
      x.setAttribute("aria-pressed", x.dataset.view === v.id));
    // Compare mode draws the comparison tiles instead of the dataset's own, so reload on either change.
    if (v.source !== state.source?.id || wasCompare !== (v.mode === "compare")) {
      setSource(cfg.sources.find((s) => s.id === v.source));
    } else refresh();
  }

  // --- colour + focus ---------------------------------------------------------
  // Segments of the selected place (every place for ALL).
  const inCityExpr = () => state.city === ALL ? true : ["==", ["get", "place"], state.city ?? ""];
  // Focus: one CAN-BICS class, or one source class (all of it, whatever classes it was assigned).
  function focusExpr({ cls, sc }) {
    const e = ["all", inCityExpr()];
    if (sc !== undefined) e.push(["==", ["get", "source_class"], sc]);
    if (cls !== undefined) e.push(["==", ["get", "class"], cls]);
    return e;
  }

  // Faded lines use colours pre-mixed with the basemap, drawn opaque: semi-transparent lines would
  // darken where they overlap. Strong (selected / focused) lines are drawn on top.
  const DIM = 0.12;
  const statusColors = (k) => ["match", ["get", "status"], "only", k(ck.colors.only_a), "differs", k(ck.colors.differs), k(ck.colors.agree)];
  function applyStyle() {
    // Focus dims everything else rather than hiding it, to keep context.
    // Without focus, segments outside the selected city are faded.
    const inCity = inCityExpr();
    const compare = state.mode === "compare";
    const strong = compare
      ? (state.cmpFocus ? ["all", inCity, cmpFocusExpr(state.cmpFocus)] : inCity)
      : (state.focus ? focusExpr(state.focus) : inCity);
    const a = (compare ? state.cmpFocus : state.focus) ? DIM : cfg.other_city_opacity;
    // Compare: coloured by match status; class rows in the key only filter.
    const color = compare ? (k) => statusColors(k) : (k) => classColorExpr(cfg, k);
    const hidden = compare ? cmpHiddenExpr() : state.showNC ? false : ncExpr("class");
    net.setPaint(["case", strong, color((c) => c), color((c) => fade(c, a))],
      ["case", hidden, 0, 1], ["case", strong, 1, 0]);
    other.show(compare);
  }

  // --- picking a city on the map -------------------------------------------------
  // Hovering another place's area tints it and names it; clicking it selects that city.
  // Segments keep priority (their popup), so this only applies off the network.
  const areaTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "area-tip", offset: 14 });
  let hovered = null;
  const onLine = (pt) => net.featureAt(pt)
    || lineAt(map, pt, "cmp-b-only");
  const otherPlaceAt = (pt) => {
    const id = areas && !onLine(pt) && areas.placeAt(pt);
    return id && id !== state.city && state.summary?.places[id] ? id : null;
  };
  function setHover(id, lngLat) {
    if (id !== hovered) {
      hovered = id;
      areas?.hover(id);
      if (!id) areaTip.remove();
      else {
        areaTip.setHTML(esc(state.summary.places[id].name));
      }
    }
    if (id) areaTip.setLngLat(lngLat).addTo(map);
  }
  map.on("mousemove", (e) => {
    const id = otherPlaceAt(e.point);
    setHover(id, e.lngLat);
    if (id) map.getCanvas().style.cursor = "pointer";
  });
  map.getCanvas().addEventListener("mouseleave", () => setHover(null));
  map.on("click", (e) => {
    const id = otherPlaceAt(e.point);
    if (!id) return;
    setHover(null);
    setCity(id); // the view stays put; the user pans/zooms themselves
  });

  // --- comparison -------------------------------------------------------------
  // Compare mode: the baseline (compare_key.a) is drawn from the comparison tiles, layer "a", coloured
  // by match status (match / class differs / nothing in the other dataset). The class key stays,
  // greyed, as a filter. The other
  // dataset's unmatched stretches (layer "b", status "only") are drawn on top in a second flat colour.
  const ck = cfg.compare_key;
  const cmpPair = ck && cfg.comparisons.find((c) => c.a === ck.a && c.b === ck.b);
  const shortName = (id) => cfg.sources.find((s) => s.id === id)?.short ?? id;
  const srcA = ck && cfg.sources.find((s) => s.id === ck.a);
  const compareSrc = cmpPair && { ...cmpPair, attribution: srcA?.attribution, fields: srcA?.fields };
  const A = () => shortName(ck.a), B = () => shortName(ck.b);

  const comfortOf = Object.fromEntries(classes.map((c) => [c.slug, c.comfort]));
  const isNC = (slug) => comfortOf[slug] === "non_conforming";
  // Hidden unless includeNC: non-conforming stretches that are missing from the other dataset or
  // non-conforming there too. Conforming vs non-conforming differences always show.
  const cmpHidden = (status, cls, other) => !state.includeNC && isNC(cls) && (status === "only" || isNC(other));
  // A network feature that's drawn invisible (so it shouldn't take clicks either).
  const ncHidden = (p) => state.mode === "compare" ? cmpHidden(p.status, p.class, p.other_class) : !state.showNC && isNC(p.class);

  // The same, as map expressions over a comparison feature (status, class, other_class).
  const ncExpr = (prop) => ["in", ["coalesce", ["get", prop], ""],
    ["literal", classes.filter((c) => isNC(c.slug)).map((c) => c.slug)]];
  const cmpHiddenExpr = () => state.includeNC ? false
    : ["all", ncExpr("class"), ["any", ["==", ["get", "status"], "only"], ncExpr("other_class")]];

  // cmpFocus: {side?, status?, cls?, other?}. side "b" = the other dataset's missing stretches;
  // side "a" marks rows under the status summary (so class rows don't open). Unset keys = any.
  const sameFocus = (x, y) => !!x && !!y && ["side", "status", "cls", "other"].every((k) => x[k] === y[k]);
  const cmpFocusExpr = (f) => {
    if (f.side === "b") return false;
    const e = ["all"];
    if (f.status) e.push(["==", ["get", "status"], f.status]);
    if (f.cls) e.push(["==", ["get", "class"], f.cls]);
    if (f.other) e.push(["==", ["get", "other_class"], f.other]);
    return e;
  };

  // Compare popups: who says what, rather than stating one dataset's class as fact.
  const statusSw = (st) => `<span class="swatch" style="background:${ck.colors[{ agree: "agree", differs: "differs", only: "only_a" }[st]]}"></span>`;
  const cmpTitle = (p) => `${statusSw(p.status)}${esc({ agree: "Match", differs: "Class differs", only: `Missing in ${B()}` }[p.status] ?? p.status)}`;
  const says = (who, html) => `<tr><th>${esc(who)} says</th><td>${html}</td></tr>`;
  const clsHtml = (slug) => `<span class="swatch inline" style="background:${classInfo(cfg, slug).color}"></span>${esc(classInfo(cfg, slug).label)}`;
  function matchRows(p) {
    const tol = state.cmpSummary?.tolerance_m ?? 20;
    return says(A(), clsHtml(p.class)) + says(B(), p.status === "agree" ? clsHtml(p.class)
      : p.status === "differs" && p.other_class ? clsHtml(p.other_class)
        : `<span class="empty">nothing within ${tol} m</span>`);
  }

  // km in the current city, after the non-conforming filter.
  // byClass[slug] = {agree, differs, only, pairs: [{other, km}]}; status = totals; onlyB[slug] = km.
  function cmpKm(pid = state.city) {
    const p = state.cmpSummary?.places[pid] || { a: [], b: [] };
    const byClass = {}, status = { agree: 0, differs: 0, only: 0, onlyB: 0 }, onlyB = {};
    (p.a || []).forEach(([st, cls, other, km]) => {
      if (cmpHidden(st, cls, other)) return;
      const c = (byClass[cls] ||= { agree: 0, differs: 0, only: 0, pairs: new Map() });
      c[st] += km;
      status[st] += km;
      if (st === "differs") c.pairs.set(other, (c.pairs.get(other) || 0) + km);
    });
    (p.b || []).forEach(([st, cls, other, km]) => {
      if (st !== "only" || cmpHidden(st, cls, other)) return; // b's matched stretches are counted on a's side
      onlyB[cls] = (onlyB[cls] || 0) + km;
      status.onlyB += km;
    });
    for (const c of Object.values(byClass)) {
      c.total = c.agree + c.differs + c.only;
      c.pairs = [...c.pairs].map(([other, km]) => ({ other, km })).sort((x, y) => y.km - x.km);
    }
    return { byClass, status, onlyB };
  }

  const lineWidth = ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.5, 16, 5];
  const other = {
    added: false,
    popup: new maplibregl.Popup({ maxWidth: "280px" }),
    add() { // once the basemap + network exist; kept on top of the network
      if (!cmpPair) return;
      const top = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
      if (!this.added) {
        map.addSource("cmp", { type: "vector", url: `pmtiles://${new URL(`data/${cmpPair.tiles}`, location.href)}` });
        map.addLayer({ id: "cmp-b-only", type: "line", source: "cmp", "source-layer": "b",
          layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ck.colors.only_b, "line-width": lineWidth } }, top);
        // Same hit area as the network's lines (lineAt), so all lines are equally easy to hover / click.
        map.on("mousemove", (e) => { if (lineAt(map, e.point, "cmp-b-only")) map.getCanvas().style.cursor = "pointer"; });
        map.on("click", (e) => {
          if (net.featureAt(e.point)) return; // the baseline line under the pointer gets the popup
          const f = lineAt(map, e.point, "cmp-b-only");
          if (!f) return;
          const p = f.properties;
          const tol = state.cmpSummary?.tolerance_m ?? 20;
          this.popup.setLngLat(e.lngLat).setHTML(segmentPopup(map, cfg, f, e, {
            // b's source_class is just its class name under another spelling (e.g. Can-BICS labels).
            fields: cfg.sources.find((s) => s.id === ck.b)?.fields.filter((k) => k !== "source_class"),
            snapshot: cfg.sources.find((s) => s.id === ck.b)?.osm_snapshot,
            title: `<span class="swatch" style="background:${ck.colors.only_b}"></span>Missing in ${esc(A())}`,
            lead: says(A(), `<span class="empty">nothing within ${tol} m</span>`) + says(B(), clsHtml(p.class)),
            action: (pp, vars) => issueButton(pp, vars, "b"),
          })).addTo(map);
          wireOsmTags(this.popup.getElement());
        });
        this.added = true;
      } else {
        map.moveLayer("cmp-b-only", top);
      }
    },
    show(on) {
      if (!this.added) return;
      const inCity = inCityExpr();
      const f = state.cmpFocus;
      map.setLayoutProperty("cmp-b-only", "visibility", on ? "visible" : "none");
      if (!on) return this.popup.remove();
      map.setFilter("cmp-b-only", ["all", inCity, ["==", ["get", "status"], "only"],
        state.includeNC ? true : ["!", ncExpr("class")]]);
      const dim = fade(ck.colors.only_b, DIM);
      map.setPaintProperty("cmp-b-only", "line-color", !f ? ck.colors.only_b
        : f.side !== "b" ? dim : f.cls ? ["case", ["==", ["get", "class"], f.cls], ck.colors.only_b, dim] : ck.colors.only_b);
    },
  };

  // --- compare list -----------------------------------------------------------
  // The class key again (greyed: the map isn't coloured by class here; clicking filters to a class),
  // km as "a / b" and, when selected, the class's breakdown; then the status rows, which are the
  // map's colours.
  function fillCompare(ul) {
    const { byClass, status, onlyB } = cmpKm();
    const f = state.cmpFocus;
    const sw = (bg) => `<span class="swatch" style="background:${bg}"></span>`;
    const color = (slug) => classInfo(cfg, slug).color;
    const label = (slug) => esc(classInfo(cfg, slug).label);
    const row = (focus, html, km, { title = "Click to highlight", sub = "", kmHtml } = {}) => {
      const el = document.createElement("li");
      el.innerHTML = `<button class="row ${sameFocus(f, focus) ? "active" : ""} ${km ? "" : "empty-row"}" ${km ? "" : "disabled"}
        title="${km ? title : "None in this city"}">${html}<span class="num">${kmHtml ?? fmtKm(km)}</span></button>`;
      el.querySelector("button").onclick = () => { state.cmpFocus = sameFocus(f, focus) ? null : focus; refresh(); };
      if (sub) el.insertAdjacentHTML("beforeend", `<ul class="sc-rows">${sub}</ul>`);
      el.querySelectorAll(".sc-rows button").forEach((b) => (b.onclick = () => {
        const fo = JSON.parse(b.dataset.focus);
        state.cmpFocus = sameFocus(f, fo) ? null : fo;
        refresh();
      }));
      return el;
    };
    const subRow = (focus, html, km, title = "Click to highlight") => `<li><button class="row ${sameFocus(f, focus) ? "active" : ""}"
      data-focus="${esc(JSON.stringify(focus))}" title="${title}">${html}<span class="num">${fmtKm(km)}</span></button></li>`;
    // Class rows: each dataset's own km for the class (whole city, regardless of the filter).
    const kmA = state.summary?.places[state.city]?.by_class_km || {};
    const kmB = state.summaryB?.places[state.city]?.by_class_km || {};
    const pairKm = (a, b) => `${fmtKm(a)} <span class="b-km">/ ${fmtKm(b)}</span>`;

    // Non-conforming: a checkbox divider (with both datasets' totals) that includes / hides them.
    const ncSum = (km) => classes.filter((c) => isNC(c.slug)).reduce((t, c) => t + (km[c.slug] || 0), 0);
    const ncNames = classes.filter((c) => isNC(c.slug)).map((c) => c.label.toLowerCase()).join(", ");
    let divided = false;
    classes.forEach((c) => {
      if (isNC(c.slug) && !divided && (divided = true)) {
        ul.insertAdjacentHTML("beforeend", ncDivider(state.includeNC, pairKm(ncSum(kmA), ncSum(kmB)),
          `Include stretches where both datasets say ${ncNames}, or only one has it`));
      }
      if (isNC(c.slug) && !state.includeNC) return;
      const k = byClass[c.slug] || { total: 0, pairs: [] };
      const open = f && !f.side && f.cls === c.slug;
      const sub = open ? [
        subRow({ cls: c.slug, status: "agree" }, `<span class="name">${sw(ck.colors.agree)}Match</span>`, k.agree),
        ...k.pairs.map((x) => subRow({ cls: c.slug, status: "differs", other: x.other },
          `<span class="name">${sw(ck.colors.differs)}${esc(B())} → ${label(x.other)}</span>`, x.km)),
        k.only ? subRow({ cls: c.slug, status: "only" }, `<span class="name">${sw(ck.colors.only_a)}Missing in ${esc(B())}</span>`, k.only) : "",
      ].join("") : "";
      const a = kmA[c.slug] || 0, b = kmB[c.slug] || 0;
      const el = row({ cls: c.slug }, `${sw(c.color)}<span class="name">${esc(c.label)}</span>`, a || b,
        { sub, title: `${A()} ${fmtKm(a)} km / ${B()} ${fmtKm(b)} km. Click to show only this class`, kmHtml: pairKm(a, b) });
      if (!open) el.firstElementChild.classList.add("key-muted");
      ul.append(el);
    });

    // Status summary: whole-city totals, all clickable; differs / missing open a per-class breakdown.
    ul.insertAdjacentHTML("beforeend", `<li class="divider">Compared with ${esc(B())}</li>`);
    const byCls = (side, st, km) => classes.filter((c) => km(c.slug)).sort((x, y) => km(y.slug) - km(x.slug)).map((c) =>
      subRow({ side, status: st, cls: c.slug }, `<span class="name">${sw(side === "b" ? ck.colors.only_b : ck.colors.only_a)}${esc(c.label)}</span>`, km(c.slug))).join("");
    const openIf = (fo) => f && f.side === fo.side && f.status === fo.status;
    ul.append(row({ side: "a", status: "agree" }, `${sw(ck.colors.agree)}<span class="name">Match</span>`, status.agree));
    // Class differs opens by CCND class (largest first); a class opens what the other dataset calls it.
    const differsSub = () => classes.filter((c) => byClass[c.slug]?.differs)
      .sort((x, y) => byClass[y.slug].differs - byClass[x.slug].differs)
      .map((c) => {
        const fo = { side: "a", status: "differs", cls: c.slug };
        const open = f?.side === "a" && f.status === "differs" && f.cls === c.slug;
        const nested = open ? `<ul class="sc-rows">${byClass[c.slug].pairs.map((x) => subRow({ ...fo, other: x.other },
          `<span class="name"><span class="muted">→</span> ${label(x.other)}</span>`, x.km,
          `${esc(A())} says ${label(c.slug)}, ${esc(B())} says ${label(x.other)}`)).join("")}</ul>` : "";
        return subRow(fo, `<span class="name">${sw(c.color)}${esc(c.label)}</span>`, byClass[c.slug].differs,
          `${esc(A())} says ${esc(c.label)}; click for what ${esc(B())} says`).replace(/<\/li>$/, `${nested}</li>`);
      }).join("");
    ul.append(row({ side: "a", status: "differs" }, `${sw(ck.colors.differs)}<span class="name">Class differs</span>`, status.differs, {
      sub: openIf({ side: "a", status: "differs" }) ? differsSub() : "" }));
    ul.append(row({ side: "b" }, `${sw(ck.colors.only_b)}<span class="name">Missing in ${esc(A())}</span>`, status.onlyB, {
      title: `In ${B()}, not in ${A()}`,
      sub: f?.side === "b" ? byCls("b", undefined, (s) => onlyB[s]) : "" }));
    ul.append(row({ side: "a", status: "only" }, `${sw(ck.colors.only_a)}<span class="name">Missing in ${esc(B())}</span>`, status.only, {
      title: `In ${A()}, not in ${B()}`,
      sub: openIf({ side: "a", status: "only" }) ? byCls("a", "only", (s) => byClass[s]?.only) : "" }));

    ul.insertAdjacentHTML("afterend", `<p class="muted small" title="Matched within ${state.cmpSummary?.tolerance_m ?? 20} m. A side of the street in only one dataset shows as missing in the other.">
      km: ${esc(A())} <span class="b-km">/ ${esc(B())}</span></p>`);
    ul.querySelector(".nc-divider input").onchange = (e) => {
      state.includeNC = e.target.checked;
      state.cmpFocus = null;
      refresh();
    };
  }

  // --- issues ---------------------------------------------------------------------
  // Known data issues (config/issues.yaml) for the current place; they're about the baseline dataset.
  const cityIssues = () => state.issues.filter((i) => state.city === ALL || i.place === state.city);

  // Submission form (web.yaml report_url), prefilled with the city and the highlighted source class.
  function reportUrl() {
    if (!cfg.report_url) return null;
    const vals = { city: state.summary?.places[state.city]?.name ?? "", source_class: state.focus?.sc ?? "" };
    return cfg.report_url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vals[k] ?? ""));
  }

  // "Add issue" in a segment popup. kind: "a" (baseline tab), "b" (other dataset's tab, or its
  // stretches missing from a in compare), "cmp" (baseline in compare). The click context rides along
  // as JSON and prefills the form (startIssue).
  function issueButton(p, vars, kind) {
    const ctx = { kind, place: p.place, id: p.id, class: p.class, other: p.other_class, status: p.status,
      source_class: p.source_class, lat: +vars.lat, lng: +vars.lng, heading: vars.heading };
    return `<div class="popup-actions"><button class="add-issue" data-ctx="${esc(JSON.stringify(ctx))}">Add issue</button></div>`;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".add-issue");
    if (b) startIssue(JSON.parse(b.dataset.ctx));
  });

  // Which dataset an issue is about: the baseline (CCND) unless picked otherwise in the form.
  // Issues are listed in this order, baseline first.
  const defaultDataset = () => ck?.a ?? cfg.sources[0]?.id;
  const issueDatasets = () => [...cfg.sources].sort((x, y) => (y.id === defaultDataset()) - (x.id === defaultDataset()))
    .map((s) => ({ id: s.id, short: s.short ?? s.id }));

  // Prefill from what was clicked: class differs -> misclassified, a -> b's class; missing in a
  // (b's stretch) -> missing infrastructure, should be b's class; otherwise misclassified, a's class.
  function startIssue(c) {
    const b = c.kind === "b";
    const draft = {
      place: c.place, placeName: state.summary?.places[c.place]?.name, dataset: defaultDataset(),
      type: b ? "missing" : "wrong_class",
      class: b ? "" : c.class,
      suggested_class: b ? c.class : c.status === "differs" ? c.other : "",
      source_class: b ? "" : c.source_class ?? "",
      note: "",
      examples: [{ lat: c.lat, lng: c.lng, heading: c.heading, segment: b ? undefined : c.id,
        class: b ? undefined : c.class, other_class: b ? c.class : c.other ?? undefined,
        status: c.status ?? undefined, source_class: b ? undefined : c.source_class ?? undefined }],
    };
    Object.assign(state, { draft, issueError: null, issuesOpen: true, issueSel: null });
    refresh();
  }

  // "Add issue" in the panel: no example; class pair taken from what's highlighted in the key, if any.
  function newIssue() {
    const f = state.cmpFocus, cls = state.focus?.cls ?? f?.cls;
    const missing = f?.side === "b";
    state.draft = { place: state.city, placeName: state.summary?.places[state.city]?.name, dataset: defaultDataset(),
      type: missing ? "missing" : "wrong_class", class: missing ? "" : cls ?? "",
      suggested_class: missing ? f.cls : f?.other ?? "", source_class: state.focus?.sc ?? "", note: "", examples: [] };
    Object.assign(state, { issueError: null, issuesOpen: true, issueSel: null });
    refresh();
  }

  async function issueApi(op) {
    try {
      const r = await fetch("api/issues", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(op) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
      state.issues = res.issues;
      state.issueError = null;
      return true;
    } catch (err) {
      state.issueError = `Not saved: ${err.message}`;
      refresh();
      return false;
    }
  }

  // Selecting an issue highlights its class (pair) on the map and its example pins; the view stays put.
  function selectIssue(issue) {
    state.issueSel = issue?.id ?? null;
    state.focus = state.cmpFocus = null;
    if (issue) {
      if (state.mode === "compare") {
        state.cmpFocus = issue.class
          ? (issue.suggested_class && issue.suggested_class !== "exclude"
            ? { cls: issue.class, status: "differs", other: issue.suggested_class } : { cls: issue.class })
          : issue.suggested_class ? { side: "b", cls: issue.suggested_class } : null;
      } else if (issue.class) state.focus = { cls: issue.class };
      else if (issue.source_class) state.focus = { sc: issue.source_class };
    }
    refresh();
  }

  let exampleToken = null;
  const issueHandlers = {
    toggle: () => {
      state.issuesOpen = !state.issuesOpen;
      try { localStorage.setItem("issuesOpen", state.issuesOpen ? "1" : "0"); } catch {}
      refresh();
    },
    newIssue,
    select: selectIssue,
    // Fly to the example, then open the popup of whatever is drawn there in the current tab, as if
    // clicked (once the map has settled, so the lines are rendered and can be found).
    selectExample: (issue, n) => {
      const ex = issue.examples[n];
      if (state.issueSel !== issue.id) selectIssue(issue);
      const token = (exampleToken = {});
      map.once("idle", () => {
        if (token !== exampleToken) return; // another marker was clicked meanwhile
        const lngLat = new maplibregl.LngLat(ex.lng, ex.lat);
        map.fire("click", { lngLat, point: map.project(lngLat), originalEvent: null });
      });
      map.flyTo({ center: [ex.lng, ex.lat], zoom: Math.max(map.getZoom(), 16) });
      map.triggerRepaint(); // so "idle" fires even if the view is already there
    },
    draftChange: (vals) => {
      const d = state.draft;
      const relevant = ["dataset", "type", "class", "suggested_class"].some((k) => (vals[k] ?? "") !== (d[k] ?? ""));
      Object.assign(d, vals);
      if (relevant) refresh(); // the "same as an existing issue" hint depends on these
    },
    save: async (vals) => {
      const d = { ...state.draft, ...vals };
      const issue = { place: d.place, dataset: d.dataset || defaultDataset(), type: d.type, class: d.class,
        suggested_class: d.suggested_class, source_class: d.source_class.trim(), note: d.note.trim(), examples: d.examples };
      if (await issueApi({ op: "add", issue })) {
        state.draft = null;
        state.issueSel = state.issues.at(-1)?.id ?? null;
        refresh();
      }
    },
    cancel: () => { state.draft = null; state.issueError = null; refresh(); },
    addToExisting: async (id) => {
      if (await issueApi({ op: "add_example", id, example: state.draft.examples[0] })) {
        state.draft = null;
        selectIssue(state.issues.find((i) => i.id === id));
      }
    },
    del: async (id) => { if (await issueApi({ op: "delete", id })) { state.issueSel = null; refresh(); } },
  };

  // Example pins: the current place's issue examples (and the draft's), the selected issue's bolder.
  function issuePins() {
    if (!map.getSource("issue-pins")) {
      map.addSource("issue-pins", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "issue-pins", type: "circle", source: "issue-pins", paint: {
        "circle-radius": ["case", ["get", "sel"], 6, 4.5],
        "circle-color": ["case", ["get", "draft"], "#ffffff", "#c2255c"],
        "circle-stroke-color": ["case", ["get", "draft"], "#c2255c", "#ffffff"],
        "circle-stroke-width": ["case", ["get", "draft"], 2.5, 1.5],
        "circle-opacity": ["case", ["any", ["get", "sel"], ["get", "draft"], ["!", ["get", "anySel"]]], 1, 0.45],
        "circle-stroke-opacity": ["case", ["any", ["get", "sel"], ["get", "draft"], ["!", ["get", "anySel"]]], 1, 0.45],
      } });
      map.on("click", "issue-pins", (e) => {
        const id = e.features[0].properties.issue;
        const issue = state.issues.find((i) => i.id === id);
        if (issue) { state.issuesOpen = true; selectIssue(issue); }
      });
      map.on("mousemove", "issue-pins", () => (map.getCanvas().style.cursor = "pointer"));
    }
    const anySel = !!state.issueSel;
    const feats = cityIssues().flatMap((i) => (i.examples || []).map((ex) => ({ type: "Feature",
      geometry: { type: "Point", coordinates: [ex.lng, ex.lat] },
      properties: { issue: i.id, sel: i.id === state.issueSel, draft: false, anySel } })));
    (state.draft?.examples || []).forEach((ex) => feats.push({ type: "Feature",
      geometry: { type: "Point", coordinates: [ex.lng, ex.lat] }, properties: { draft: true, sel: false, anySel } }));
    map.getSource("issue-pins").setData({ type: "FeatureCollection", features: feats });
    map.moveLayer("issue-pins"); // keep on top
  }

  function renderIssues() {
    const name = state.summary?.places[state.city]?.name ?? "";
    IssuesPanel.render($("issues"), {
      cfg, title: name, issues: cityIssues(), draft: state.draft, selected: state.issueSel,
      canSave: state.api, canAdd: !!state.city && state.city !== ALL, error: state.issueError, open: state.issuesOpen, reportUrl: reportUrl(),
      all: state.city === ALL, placeName: (id) => state.summary?.places[id]?.name ?? id, on: issueHandlers,
      datasets: issueDatasets(), defaultDataset: defaultDataset(),
    });
    if (map.isStyleLoaded() || map.getSource("network")) issuePins();
  }

  function refresh() {
    applyStyle();
    renderIssues();
    Profile.render($("info"), {
      data: state.summary?.places[state.city], classes: cfg.classes, focus: state.focus,
      onFocus: setFocus, issues: cityIssues(),
      scAvailable: !!state.view?.source_classes && state.city !== ALL, showSc: state.showSc,
      onToggleSc: (on) => { state.showSc = on; refresh(); },
      showNC: state.showNC, classification: cfg.classification,
      onToggleNC: (on) => {
        state.showNC = on;
        // A highlighted row may have just been hidden.
        if (!on && (isNC(state.focus?.cls) || state.focus?.sc !== undefined)) state.focus = null;
        refresh();
      },
      fillList: state.mode === "compare" ? fillCompare : null,
      totalB: state.mode === "compare" && state.summaryB?.places[state.city]
        ? canbicsKm(state.summaryB.places[state.city], classes) : null,
    });
    renderTable();
  }

  // --- table (expanded panel) ---------------------------------------------------
  // The Table tab expands the panel over the map; it follows the same view tabs and search box.
  function renderTable() {
    if (!state.table) return;
    CityTable.render($("table"), {
      cfg, mode: state.mode, summary: state.summary, summaryB: state.summaryB, cmpKm,
      q: state.q, city: state.city, issues: state.issues, labels: { a: A(), b: B() },
    });
  }
  function setPanel(table) {
    state.table = table;
    state.q = "";
    document.body.classList.toggle("table-open", table);
    $("panel-tabs").querySelectorAll("a").forEach((a) =>
      a.setAttribute("aria-current", (a.dataset.panel === "table") === table ? "page" : "false"));
    setParam("panel", table ? "table" : null);
    search.setFiltering(table, state.summary?.places[state.city]?.name);
    if (table) { areaTip.remove(); net.popup.remove(); other.popup.remove(); }
    renderTable();
  }
  $("panel-tabs").querySelectorAll("a").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    setPanel(a.dataset.panel === "table");
  }));

  function setFocus(f) { state.focus = f; state.cmpFocus = null; state.issueSel = null; refresh(); }

  // Keep fitted cities clear of the side panel (desktop) / bottom sheet (mobile).
  function panelPadding() {
    const r = $("panel").getBoundingClientRect();
    if (innerWidth <= 700) return { top: 20, bottom: innerHeight - r.top + 10, left: 20, right: 20 };
    return { top: 40, bottom: 40, left: r.right + 20, right: 40 };
  }

  // Lock the map to one city. fit = zoom to its extent.
  function setCity(id, { fit = false } = {}) {
    const p = state.summary?.places[id];
    if (!p) return;
    if (fit) map.fitBounds(p.bounds, { padding: panelPadding(), duration: 1200 });
    if (id === state.city) return;
    state.city = id;
    state.focus = state.cmpFocus = state.issueSel = null;
    search.show(p.name);
    areas?.setPlace(id);
    setParam("city", id);
    rememberCity(id); // so the other tabs return here
    refresh();
  }

  async function setSource(src) {
    state.source = src;
    setParam("source", src.id);
    state.summary = await loadSummary(src);
    search.setOptions(state.summary?.places);
    if (state.mode === "compare" && compareSrc) net.setSource(compareSrc, { layer: "a" });
    else net.setSource(src);
    other.add();
    if (!areas) areas = addAreas(map, net.hiliteId); // once; stays below the network layers
    // Initial city: ?city=, else keep current, else last visited, else config default.
    const wanted = getParam("city") || state.city || lastCity() || cfg.initial_city;
    state.city = null;
    setCity(state.summary?.places[wanted] ? wanted : realPlaces(state.summary?.places)[0]?.[0],
      { fit: firstLoad && !hadViewInUrl });
    firstLoad = false;
  }

  setPanel(state.table);
  const initialView = views.find((v) => v.id === getParam("view")) || views[0];
  $("views").querySelectorAll("button").forEach((x) => // show the tab before the map has loaded
    x.setAttribute("aria-pressed", x.dataset.view === initialView.id));
  const cmpSummary = cmpPair && fetch(`data/${cmpPair.summary}`).then((r) => r.json()).then(withAll);
  const summaryB = ck && loadSummary(cfg.sources.find((s) => s.id === ck.b));
  // Basemap labels (place, road, water names…) only inside Canada (data/canada.geojson, exported).
  const canada = fetch("data/canada.geojson").then((r) => r.ok ? r.json() : null).catch(() => null);
  async function canadaLabelsOnly(labelLayers) {
    const shape = await canada;
    if (!shape) return;
    const within = ["within", shape.features?.[0]?.geometry ?? shape];
    for (const l of labelLayers) map.setFilter(l.id, l.filter ? ["all", l.filter, within] : within);
  }

  map.on("load", async () => {
    // At load the style holds only the basemap's layers; ours are added later.
    canadaLabelsOnly(map.getStyle().layers.filter((l) => l.type === "symbol"));
    state.cmpSummary = await cmpSummary;
    state.summaryB = await summaryB;
    // Live issues from the local dev server, if it's running (else the exported ones).
    try {
      const r = await fetch("api/issues");
      if (r.ok) Object.assign(state, { issues: (await r.json()).issues, api: true });
    } catch {}
    setView(initialView);
  });
}
