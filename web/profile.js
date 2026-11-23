// City info (lower part of the panel): header, km per CAN-BICS class (optionally broken down by the
// city's own source classes). Known issues are flagged with a dot (listed in the Issues panel, issues.js).
// Pure rendering; app.js owns state and the map.
// Focus = {cls} (one CAN-BICS class) or {sc} (one source class, whatever classes it was assigned to).
// In compare mode app.js passes `fillList(el)`, which draws the comparison rows in place of the classes.

const Profile = (() => {
  function render(el, { data, classes, focus, onFocus, issues = [],
    scAvailable = false, showSc = false, onToggleSc, fillList, totalB = null }) {
    showSc = showSc && scAvailable && !fillList;
    if (!data) {
      el.innerHTML = `<p class="empty-state">Search for a city above.</p>`;
      return;
    }
    const prov = data.provenance || {};
    const flagged = new Set(issues.map((i) => i.source_class).filter((v) => v != null));
    const flaggedCls = new Set(issues.map((i) => i.class).filter(Boolean));
    const dot = `<span class="issue-dot" title="Has a known issue (see Issues)">!</span>`;

    // Source classes per CAN-BICS class: {slug: [{sc, km}]}, largest first.
    const scBy = {};
    data.crosswalk.filter((r) => r.in_data).forEach((r) => {
      const m = (scBy[r.class] ||= new Map());
      m.set(r.source_class, (m.get(r.source_class) || 0) + r.km);
    });
    for (const k in scBy) scBy[k] = [...scBy[k]].map(([sc, km]) => ({ sc, km })).sort((a, b) => b.km - a.km);
    const splitSc = new Set(); // source classes listed under more than one class
    const seen = new Set();
    Object.values(scBy).flat().forEach(({ sc }) => (seen.has(sc) ? splitSc.add(sc) : seen.add(sc)));

    // Non-conforming classes are listed after a divider; they don't count towards the headline km.
    let divided = false;
    const rows = classes.classes.map((c) => {
      const km = data.by_class_km[c.slug] || 0;
      const subs = scBy[c.slug] || [];
      const active = focus?.cls === c.slug;
      const hasIssue = flaggedCls.has(c.slug) || (!showSc && subs.some((s) => flagged.has(s.sc)));
      const sub = showSc && subs.length ? `<ul class="sc-rows">${subs.map((s) => `<li>
          <button class="row ${focus?.sc === s.sc ? "active" : ""}" data-sc="${esc(s.sc)}"
            title="${splitSc.has(s.sc) ? "Split across several classes; highlights all of it" : "Highlight on the map"}">
            <span class="name">${showWs(s.sc)}${splitSc.has(s.sc) ? ` <span class="muted">*</span>` : ""}${flagged.has(s.sc) ? ` ${dot}` : ""}</span>
            <span class="num">${fmtKm(s.km)}</span></button></li>`).join("")}</ul>` : "";
      const divider = c.comfort === "non_conforming" && !divided && (divided = true)
        ? `<li class="divider">Non-conforming</li>` : "";
      return `${divider}<li><button class="row ${active ? "active" : ""} ${km ? "" : "empty-row"}" ${km ? `data-cls="${c.slug}"` : "disabled"}
          title="${km ? `${esc(c.comfort.replace("_", "-"))}. Click to highlight` : "None in this city"}">
          <span class="swatch" style="background:${c.color}"></span>
          <span class="name">${esc(c.label)}${hasIssue ? ` ${dot}` : ""}</span>
          <span class="num">${fmtKm(km)}</span></button>${sub}</li>`;
    }).join("");

    const toggle = scAvailable && !fillList ? `<label class="sc-toggle"><input type="checkbox" ${showSc ? "checked" : ""}>
      Source classes</label>` : "";

    const link = (url, text) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${text}</a>` : "";
    const meta = [`${fmtKm(data.total_km)} km incl. non-conforming`, prov.provider, prov.year_updated && `data ${prov.year_updated}`].filter(Boolean).map(esc)
      .concat([link(prov.source_url, "source"), link(prov.license, "licence")].filter(Boolean));

    el.innerHTML = `
      <header>
        <h2>${esc(data.name)}<span class="total" title="CAN-BICS classes (excludes non-conforming)${totalB == null ? "" : "; compared dataset after the slash"}"><b>${fmtKm(canbicsKm(data, classes.classes)).replace("–", "0")}</b>${totalB == null ? "" : ` <span class="b-km">/ ${fmtKm(totalB).replace("–", "0")}</span>`} km</span></h2>
      </header>
      <section>
        <ul class="rows">${fillList ? "" : rows}</ul>
        ${toggle ? `<div class="list-foot">${toggle}${showSc && splitSc.size ? `<span class="muted small">* split across classes</span>` : ""}</div>` : ""}
      </section>
      ${meta.length ? `<footer class="meta muted" title="${esc(prov.attribution ?? "")}">${meta.join(" · ")}</footer>` : ""}`;

    if (fillList) fillList(el.querySelector(".rows"));
    el.querySelectorAll("button[data-cls]").forEach((b) => (b.onclick = () =>
      onFocus(focus?.cls === b.dataset.cls ? null : { cls: b.dataset.cls })));
    el.querySelectorAll("button[data-sc]").forEach((b) => (b.onclick = () =>
      onFocus(focus?.sc === b.dataset.sc ? null : { sc: b.dataset.sc })));
    el.querySelector(".sc-toggle input")?.addEventListener("change", (e) => onToggleSc(e.target.checked));
  }

  return { render };
})();
