// All-cities table, shown when the side panel is expanded (Table tab). Pure rendering; app.js owns
// state and passes the current view's data. Follows the view tabs: CCND / OSM show km per CAN-BICS
// class; Compare shows the match results. Clicking a row opens details under it: in Compare, the same
// columns per CAN-BICS class; otherwise provenance and flags.

const CityTable = (() => {
  let sort = { key: "canbics", dir: -1 };
  let openId = null;

  // ctx: {cfg, mode, summary, summaryB, cmpKm(pid), q, city, issues, labels: {a, b}}
  function render(el, ctx) {
    const { cfg, mode, summary } = ctx;
    const classes = cfg.classes.classes;
    const conforming = classes.filter((c) => c.comfort !== "non_conforming");
    const nc = classes.filter((c) => c.comfort === "non_conforming");
    if (!summary) { el.innerHTML = ""; return; }

    const cols = [
      { key: "name", label: "City", text: true, value: (r) => r.name },
      { key: "province", label: "Prov.", text: true, value: (r) => r.province },
    ];
    if (mode === "compare") {
      const { a, b } = ctx.labels;
      const col = ctx.cfg.compare_key.colors;
      cols.push(
        { key: "canbics", label: a, value: (r) => r.canbics, title: `${a} CAN-BICS km` },
        { key: "canbics_b", label: b, value: (r) => r.canbicsB, title: `${b} CAN-BICS km`, muted: true },
        { key: "agree", label: "Match", color: col.agree, value: (r) => r.cmp.agree },
        { key: "differs", label: "Class differs", color: col.differs, value: (r) => r.cmp.differs },
        { key: "only_b", label: `Missing in ${a}`, color: col.only_b, value: (r) => r.cmp.onlyB },
        { key: "only_a", label: `Missing in ${b}`, color: col.only_a, value: (r) => r.cmp.only },
      );
    } else {
      cols.push(
        { key: "canbics", label: "Total (CAN-BICS)", value: (r) => r.canbics,
          title: "Total km of the five CAN-BICS classes (excludes non-conforming)" },
        ...conforming.map((c) => ({ key: c.slug, label: c.label, color: c.color, value: (r) => r.byClass[c.slug] || 0 })),
        { key: "nc", label: "Non-conf.", muted: true, value: (r) => nc.reduce((t, c) => t + (r.byClass[c.slug] || 0), 0),
          title: nc.map((c) => c.label).join(", ") },
      );
    }
    if (!cols.some((c) => c.key === sort.key)) sort = { key: "canbics", dir: -1 };

    const q = (ctx.q || "").trim().toLowerCase();
    const rows = realPlaces(summary.places).map(([id, p]) => ({
      id, name: p.name, province: (p.province || "").toUpperCase(), byClass: p.by_class_km, p,
      canbics: canbicsKm(p, classes),
      canbicsB: ctx.summaryB?.places[id] ? canbicsKm(ctx.summaryB.places[id], classes) : 0,
      cmp: mode === "compare" ? ctx.cmpKm(id).status : null,
    }))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.province.toLowerCase() === q)
      .sort((x, y) => {
        const c = cols.find((k) => k.key === sort.key);
        const vx = c.value(x), vy = c.value(y);
        return (c.text ? String(vx).localeCompare(vy) : vx - vy) * sort.dir;
      });

    const head = cols.map((c) => `<th class="${c.text ? "" : "num"} ${c.key === sort.key ? "sorted" : ""}" data-key="${c.key}"
        title="${esc(c.title ?? c.label)}"><span>${c.color ? `<span class="swatch" style="background:${c.color}"></span>` : ""}${esc(c.label)}${c.key === sort.key ? (sort.dir < 0 ? " ↓" : " ↑") : ""}</span></th>`).join("");
    const body = rows.map((r) => {
      const cells = cols.map((c) => c.text
        ? `<td class="${c.key === "name" ? "name" : "muted"}">${esc(c.value(r))}</td>`
        : `<td class="num ${c.muted ? "muted" : ""}">${fmtKm(c.value(r))}</td>`).join("");
      const tr = `<tr data-id="${r.id}" tabindex="0" class="${r.id === ctx.city ? "current" : ""} ${r.id === openId ? "open" : ""}">${cells}</tr>`;
      if (r.id !== openId) return tr;
      return tr + (mode === "compare" ? classRows(r, cols, ctx)
        : `<tr class="detail"><td colspan="${cols.length}">${detail(r, ctx)}</td></tr>`);
    }).join("");

    // Total of the listed cities (follows the filter), pinned under the header.
    const n = realPlaces(summary.places).length;
    const total = `<tr class="total-row">${cols.map((c, i) => i === 0
      ? `<td class="name">${rows.length === n ? `All ${n} cities` : `Total (${rows.length})`}</td>`
      : c.text ? "<td></td>"
        : `<td class="num ${c.muted ? "muted" : ""}">${fmtKm(rows.reduce((t, r) => t + c.value(r), 0))}</td>`).join("")}</tr>`;
    el.innerHTML = `<div class="table-scroll"><table class="cities">
        <thead><tr>${head}</tr>${rows.length ? total : ""}</thead><tbody>${body}</tbody></table></div>
      <p class="muted small table-foot">${rows.length === n ? `${n} cities` : `${rows.length} of ${n} cities`} · km · ${esc(attribution(ctx))}</p>`;

    el.querySelectorAll("th[data-key]").forEach((th) => (th.onclick = () => {
      const c = cols.find((k) => k.key === th.dataset.key);
      sort = { key: c.key, dir: sort.key === c.key ? -sort.dir : c.text ? 1 : -1 };
      render(el, ctx);
    }));
    el.querySelectorAll("tbody tr[data-id]").forEach((tr) => {
      const toggle = () => { openId = openId === tr.dataset.id ? null : tr.dataset.id; render(el, ctx); };
      tr.onclick = toggle;
      tr.onkeydown = (e) => e.key === "Enter" && toggle();
    });
  }

  // Compare: one row per CAN-BICS class under the open city, in the table's own columns. Match, class
  // differs and missing in b are by a's class; missing in a by b's class (a has nothing there).
  function classRows(r, cols, ctx) {
    const { byClass, onlyB } = ctx.cmpKm(r.id);
    const kmA = r.p.by_class_km || {}, kmB = ctx.summaryB?.places[r.id]?.by_class_km || {};
    const val = (key, slug) => ({
      canbics: kmA[slug], canbics_b: kmB[slug], agree: byClass[slug]?.agree, differs: byClass[slug]?.differs,
      only_b: onlyB[slug], only_a: byClass[slug]?.only })[key] || 0;
    return ctx.cfg.classes.classes.filter((c) => cols.some((k) => !k.text && val(k.key, c.slug))).map((c) =>
      `<tr class="detail class-row">${cols.map((k) => k.key === "name"
        ? `<td class="name"><span class="swatch" style="background:${c.color}"></span>${esc(c.label)}</td>`
        : k.text ? "<td></td>" : `<td class="num ${k.muted ? "muted" : ""}">${fmtKm(val(k.key, c.slug))}</td>`).join("")}</tr>`).join("");
  }

  // Detail line: provenance, flags and issues as pills, and a way to the map.
  function detail(r, ctx) {
    const prov = r.p.provenance || {};
    const link = (url, text) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${text} ↗</a>` : "";
    const inData = r.p.crosswalk.filter((x) => x.in_data);
    const pills = [];
    new Set(inData.filter((x) => x.split).map((x) => x.source_class.trim()))
      .forEach((sc) => pills.push(["flag", `Split: ${sc}`]));
    inData.filter((x) => x.dictionary_class && x.dictionary_class !== x.class)
      .forEach((x) => pills.push(["flag", `≠ dictionary: ${x.source_class.trim()}`]));
    const issues = (ctx.issues || []).filter((i) => i.place === r.id);
    if (issues.length) pills.unshift(["issue", `${issues.length} issue${issues.length > 1 ? "s" : ""}`]);
    const meta = [prov.provider, prov.year_updated && `data ${prov.year_updated}`].filter(Boolean).map(esc)
      .concat([link(prov.source_url, "source"), link(prov.license, "licence")].filter(Boolean));
    return `<div class="detail-row">
      <span class="muted">${meta.join(" · ")}</span>
      ${pills.map(([k, t]) => `<span class="pill pill-${k}">${esc(t)}</span>`).join("")}</div>`;
  }

  const attribution = (ctx) => [...new Set((ctx.cfg.sources || []).map((s) => s.attribution).filter(Boolean))].join("; ");

  return { render };
})();
