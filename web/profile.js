// City profile panel: km by CAN-BICS class + source-class assignment for one place.
// Pure rendering; app.js owns state and the map.
// Focus = {cls, sc, sec}: sec undefined = any secondary class, null = no secondary value.

const Profile = (() => {
  const COMFORT_LABEL = { high: "high comfort", medium: "medium comfort", low: "low comfort",
    non_conforming: "non-conforming" };

  // Why one source class is assigned to several CAN-BICS classes: [label, tooltip].
  const SPLIT = {
    secondary: ["split by secondary class", "Assigned to more than one CAN-BICS class, depending on its secondary class"],
    spelling: ["split by spelling variant", "Spelling variants of this source class (e.g. trailing spaces) were assigned to different CAN-BICS classes"],
    unexplained: ["split, rule unknown", "Assigned to more than one CAN-BICS class; neither secondary class nor spelling explains it"],
  };

  const fmt = (km, d = 1) => km.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);
  const same = (a, b) => !!a && !!b && a.cls === b.cls && a.sc === b.sc && a.sec === b.sec;

  function render(el, { data, classes, focus, onFocus }) {
    if (!data) {
      el.innerHTML = `<p class="empty-state">Search for a city on the left.</p>`;
      return;
    }
    const byslug = Object.fromEntries(classes.classes.map((c) => [c.slug, c]));
    const cls = (slug) => byslug[slug] || { ...classes.unknown, slug, label: slug ?? "Unknown" };
    const total = data.total_km;
    const prov = data.provenance || {};
    const focusKeys = new Map(); // id -> focus object, for click handlers
    const fkey = (f) => { const id = `f${focusKeys.size}`; focusKeys.set(id, f); return id; };

    // --- breakdown by class ---
    const entries = Object.entries(data.by_class_km).map(([slug, km]) => ({ c: cls(slug), km }));
    const bar = entries.map(({ c, km }) =>
      `<div class="seg" style="flex:${km};background:${c.color}"
        data-tip="${esc(c.label)} · ${fmt(km, 0)} km (${pct(km, total)}%)"></div>`).join("");
    const rows = entries.map(({ c, km }) => {
      const f = { cls: c.slug, sc: undefined, sec: undefined };
      return `<tr class="${same(f, focus) ? "active" : ""}"><td><button data-f="${fkey(f)}" title="Highlight on the map">
        <span class="swatch" style="background:${c.color}"></span>${esc(c.label)}</button></td>
       <td class="num">${fmt(km, 0)}</td><td class="num muted">${pct(km, total)}%</td></tr>`;
    }).join("");
    const comfort = {};
    entries.forEach(({ c, km }) => (comfort[c.comfort] = (comfort[c.comfort] || 0) + km));
    const comfortRows = Object.keys(COMFORT_LABEL)
      .map((k) => `<span><b>${fmt(comfort[k] || 0, 0)}</b> km ${COMFORT_LABEL[k]}
        <span class="muted">(${pct(comfort[k] || 0, total)}%)</span></span>`).join("");

    // --- source class assignment, grouped by CAN-BICS class ---
    const inData = data.crosswalk.filter((r) => r.in_data);
    const maxKm = Math.max(...inData.map((r) => r.km), 1);
    const order = classes.classes.map((c) => c.slug);
    const groups = new Map();
    [...inData].sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class))
      .forEach((r) => (groups.get(r.class) || groups.set(r.class, []).get(r.class)).push(r));

    const secondaryList = (r) => {
      if (!r.secondary.length) return "";
      const open = r.split === "secondary" || (focus && focus.cls === r.class && focus.sc === r.source_class);
      const items = r.secondary.map((s) => {
        const f = { cls: r.class, sc: r.source_class, sec: s.value };
        return `<li class="${same(f, focus) ? "active" : ""}"><button data-f="${fkey(f)}">
          <span class="sc-name">${s.value === null ? '<span class="empty">no secondary class</span>' : showWs(s.value)}</span>
          <span class="num">${fmt(s.km)} km</span></button></li>`;
      }).join("");
      return `<details class="secondary" ${open ? "open" : ""}>
        <summary>Secondary class (${r.secondary.length})</summary><ul>${items}</ul></details>`;
    };

    const scRow = (r, c) => {
      const f = { cls: r.class, sc: r.source_class, sec: undefined };
      const flags = [
        r.split && `<span class="flag" title="${esc(SPLIT[r.split][1])}">${esc(SPLIT[r.split][0])}</span>`,
        r.dictionary_class && r.dictionary_class !== r.class &&
          `<span class="flag" title="StatCan's classification dictionary says ${esc(r.dictionary_class)}">≠ dictionary (${esc(r.dictionary_class)})</span>`,
        r.example_url && `<a href="${esc(r.example_url)}" target="_blank" rel="noopener" title="StatCan's example for this assignment">example ↗</a>`,
      ].filter(Boolean).join("");
      return `<li class="sc ${same(f, focus) ? "active" : ""}">
        <button data-f="${fkey(f)}" title="Show only these segments on the map">
          <span class="sc-name">${showWs(r.source_class)}</span><span class="num">${fmt(r.km)} km</span>
        </button>
        <div class="sc-bar"><span style="width:${(r.km / maxKm) * 100}%;background:${c.color}"></span></div>
        ${flags ? `<div class="sc-meta">${flags}</div>` : ""}
        ${secondaryList(r)}
      </li>`;
    };

    const groupsHtml = [...groups].map(([slug, items]) => {
      const c = cls(slug);
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

    const focusLabel = focus && [focus.sc === undefined ? cls(focus.cls).label : focus.sc,
      focus.sec === undefined ? null : focus.sec ?? "no secondary class"]
      .filter((v) => v !== null).join(" · ");
    const focusChip = focus ? `<div class="focus-chip">Showing only <b>${esc(focusLabel)}</b>
      <button data-clear title="Show all segments">×</button></div>` : "";

    const link = (url, label) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>` : "";
    const links = [link(prov.source_url, "Source data"), link(prov.license, "Licence")].filter(Boolean).join(" · ");

    el.innerHTML = `
      <header>
        <h2>${esc(data.name)}</h2>
        <div class="total"><b>${fmt(total, 0)}</b> km</div>
        <div class="muted">${esc([prov.provider, prov.year_updated && `data ${prov.year_updated}`]
          .filter(Boolean).join(" · "))}</div>
        ${links ? `<div class="links">${links}</div>` : ""}
        ${focusChip}
      </header>
      <section>
        <h3>By CAN-BICS class</h3>
        <div class="stack" role="img" aria-label="Km by CAN-BICS class">${bar}</div>
        <div class="comfort-summary">${comfortRows}</div>
        <table class="class-table">${rows}</table>
      </section>
      <section>
        <h3>Source class → CAN-BICS class</h3>
        <p class="hint">How ${esc(data.name)}'s own categories were assigned. Click one to highlight it on the map.</p>
        ${groupsHtml}
        ${excludedHtml}
      </section>
      ${prov.attribution ? `<footer class="muted">${esc(prov.attribution)}</footer>` : ""}`;

    el.querySelectorAll("button[data-f]").forEach((b) => (b.onclick = () => {
      const f = focusKeys.get(b.dataset.f);
      onFocus(same(f, focus) ? null : f);
    }));
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
