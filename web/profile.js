// City profile panel: km by CAN-BICS class + source-class assignment for one municipality.
// Pure rendering; app.js owns state and the map.

const Profile = (() => {
  const COMFORT_LABEL = { high: "High comfort", medium: "Medium comfort", low: "Low comfort",
    non_conforming: "Non-conforming", unknown: "Unknown" };

  const fmt = (km, d = 1) => km.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);

  function render(el, { name, data, classes, focus, onFocus }) {
    if (!data) {
      el.innerHTML = `<p class="empty-state">Pan to a city with data, or pick one on the left.</p>`;
      return;
    }
    const byslug = Object.fromEntries(classes.classes.map((c) => [c.slug, c]));
    const cls = (slug) => byslug[slug] || { ...classes.unknown, slug, label: slug ?? "Unknown" };
    const total = data.total_km;
    const prov = data.provenance || {};

    // --- breakdown by class ---
    const entries = Object.entries(data.by_class_km).map(([slug, km]) => ({ c: cls(slug), km }));
    const bar = entries.map(({ c, km }) =>
      `<div class="seg" style="flex:${km};background:${c.color}"
        data-tip="${esc(c.label)} · ${fmt(km, 0)} km (${pct(km, total)}%)"></div>`).join("");
    const rows = entries.map(({ c, km }) =>
      `<tr><td><span class="swatch" style="background:${c.color}"></span>${esc(c.label)}</td>
       <td class="num">${fmt(km, 0)}</td><td class="num muted">${pct(km, total)}%</td></tr>`).join("");

    const comfort = {};
    entries.forEach(({ c, km }) => (comfort[c.comfort] = (comfort[c.comfort] || 0) + km));
    const comfortRows = ["high", "medium", "low", "non_conforming"]
      .map((k) => `<span><b>${fmt(comfort[k] || 0, 0)}</b> km ${COMFORT_LABEL[k].toLowerCase()}
        <span class="muted">(${pct(comfort[k] || 0, total)}%)</span></span>`).join("");

    // --- source class assignment, grouped by CAN-BICS class ---
    const maxKm = Math.max(...data.crosswalk.map((r) => r.km), 1);
    const groups = new Map();
    data.crosswalk.filter((r) => r.in_data).forEach((r) => {
      if (!groups.has(r.class)) groups.set(r.class, []);
      groups.get(r.class).push(r);
    });
    const order = classes.classes.map((c) => c.slug);
    const sorted = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));

    const scRow = (r, c) => {
      const active = focus === r.source_class;
      const mismatch = r.dictionary_class && r.dictionary_class !== r.class
        ? `<span class="flag" title="Dictionary says ${esc(r.dictionary_class)}">≠ dictionary</span>` : "";
      const ex = r.example_url ? `<a href="${esc(r.example_url)}" target="_blank" rel="noopener"
        title="StatCan's example for this assignment">example ↗</a>` : "";
      return `<li class="sc ${active ? "active" : ""}">
        <button data-sc="${esc(r.source_class)}" title="Show only these segments on the map">
          <span class="sc-name">${esc(r.source_class)}</span>
          <span class="num">${fmt(r.km)} km</span>
        </button>
        <div class="sc-bar"><span style="width:${(r.km / maxKm) * 100}%;background:${c.color}"></span></div>
        <div class="sc-meta">${mismatch}${ex}</div>
      </li>`;
    };

    const groupsHtml = sorted.map((slug) => {
      const c = cls(slug);
      const items = groups.get(slug);
      const km = items.reduce((s, r) => s + r.km, 0);
      return `<div class="group">
        <h4><span class="swatch" style="background:${c.color}"></span>${esc(c.label)}
          <span class="num muted">${fmt(km, 0)} km</span></h4>
        <ul>${items.map((r) => scRow(r, c)).join("")}</ul></div>`;
    }).join("");

    const excluded = data.crosswalk.filter((r) => !r.in_data);
    const excludedHtml = excluded.length ? `<div class="group excluded">
      <h4>Not in dataset <span class="muted">(${esc(excluded[0].class || "not_classified")})</span></h4>
      <ul>${excluded.map((r) => `<li class="sc-plain">${esc(r.source_class)}${r.example_url
        ? ` <a href="${esc(r.example_url)}" target="_blank" rel="noopener">example ↗</a>` : ""}</li>`).join("")}</ul>
      </div>` : "";

    const focusChip = focus ? `<div class="focus-chip">Showing only <b>${esc(focus)}</b>
      <button data-clear title="Show all segments">×</button></div>` : "";

    el.innerHTML = `
      <header>
        <h2>${esc(name)}</h2>
        <div class="total"><b>${fmt(total, 0)}</b> km</div>
        <div class="muted">${esc([prov.provider, prov.year_updated && `data ${prov.year_updated}`]
          .filter(Boolean).join(" · "))}</div>
      </header>
      <section>
        <h3>By CAN-BICS class</h3>
        <div class="stack" role="img" aria-label="Km by CAN-BICS class">${bar}</div>
        <div class="comfort-summary">${comfortRows}</div>
        <table class="class-table">${rows}</table>
      </section>
      <section>
        <h3>Source class → CAN-BICS class</h3>
        <p class="hint">How ${esc(name)}'s own categories were assigned. Click one to isolate it on the map.</p>
        ${focusChip}
        ${groupsHtml}
        ${excludedHtml}
      </section>
      <footer class="muted">
        ${prov.source_url ? `<a href="${esc(prov.source_url)}" target="_blank" rel="noopener">Source data ↗</a>` : ""}
        ${prov.license ? ` · <a href="${esc(prov.license)}" target="_blank" rel="noopener">Licence ↗</a>` : ""}
        ${prov.attribution ? `<p>${esc(prov.attribution)}</p>` : ""}
      </footer>`;

    el.querySelectorAll("button[data-sc]").forEach((b) =>
      (b.onclick = () => onFocus(focus === b.dataset.sc ? null : b.dataset.sc)));
    el.querySelector("button[data-clear]")?.addEventListener("click", () => onFocus(null));
    bindTooltips(el);
  }

  function bindTooltips(el) {
    let tip = document.getElementById("tip");
    if (!tip) { tip = document.createElement("div"); tip.id = "tip"; document.body.append(tip); }
    el.querySelectorAll("[data-tip]").forEach((s) => {
      s.onmousemove = (e) => {
        tip.textContent = s.dataset.tip;
        tip.style.display = "block";
        tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
        tip.style.top = `${e.clientY + 14}px`;
      };
      s.onmouseleave = () => (tip.style.display = "none");
    });
  }

  function esc(v) {
    return String(v ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  }

  return { render };
})();
