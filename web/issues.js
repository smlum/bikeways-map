// Issues panel (right): the selected place's known issues, and the form for a new one, prefilled from
// a clicked segment ("Add issue" in its popup). An issue is usually a place + class pair ("bike path
// that should be multi-use path"); clicked segments are its examples. Pure rendering; app.js owns
// state, saving (scripts/serve.py issues API) and the map.

const IssuesPanel = (() => {
  // ctx: {cfg, title, issues, draft, selected, canSave, canAdd, error, open, reportUrl, placeName(id),
  //       on: {toggle, newIssue, select, selectExample, save, cancel, addToExisting, del, draftChange}}
  function render(el, ctx) {
    const { cfg, issues, draft, on } = ctx;
    const classes = cfg.classes.classes;
    const label = (slug) => slug === "exclude" ? "Not cycling infrastructure"
      : classes.find((c) => c.slug === slug)?.label ?? slug;
    const sw = (slug) => slug && slug !== "exclude"
      ? `<span class="swatch" style="background:${classInfo(cfg, slug).color}"></span>` : "";
    const types = cfg.issue_types || {};

    const head = `<header class="issues-head">
        <button class="issues-toggle" title="${ctx.open ? "Hide" : "Show"} issues">
          <h2>Issues${issues.length ? ` <span class="count">${issues.length}</span>` : ""}</h2>
          <span class="muted">${esc(ctx.title)}</span><span class="chev">${ctx.open ? "▾" : "▸"}</span></button>
      </header>`;
    if (!ctx.open) { el.innerHTML = head; wire(); return; }

    const add = !draft && ctx.canAdd ? `<div class="issues-add"><button class="new-issue">Add issue</button>
      <span class="muted">or click a segment</span></div>
      ${ctx.canSave ? "" : `<p class="muted small">Read-only: saving needs the local server (scripts/serve.py).</p>`}` : "";
    // One section per dataset (baseline first); issues without a dataset belong to the baseline.
    const datasets = ctx.datasets || [];
    const dsOf = (i) => i.dataset || ctx.defaultDataset;
    const shortOf = (id) => datasets.find((d) => d.id === id)?.short ?? id;
    const form = draft ? draftForm() : "";
    const order = [...datasets.map((d) => d.id), ...new Set(issues.map(dsOf))].filter((v, n, a) => a.indexOf(v) === n);
    const byDataset = (its, head) => order.map((ds) => {
      const g = its.filter((i) => dsOf(i) === ds);
      return g.length ? `${head(ds)}<ul class="issue-list">${g.map(item).join("")}</ul>` : "";
    }).join("");
    // One city: a section per dataset. All cities: a section per city (A–Z), its issues by dataset,
    // with dataset sub-headings only where a city has issues on more than one dataset.
    const list = !ctx.all
      ? byDataset(issues, (ds) => `<h3 class="issue-ds">${esc(shortOf(ds))}</h3>`)
      : [...new Set(issues.map((i) => i.place))]
        .sort((a, b) => ctx.placeName(a).localeCompare(ctx.placeName(b)))
        .map((pid) => {
          const its = issues.filter((i) => i.place === pid);
          const mixed = new Set(its.map(dsOf)).size > 1;
          return `<section class="issue-group"><h3 class="issue-city">${esc(ctx.placeName(pid))}</h3>
            ${byDataset(its, (ds) => mixed ? `<h4 class="issue-ds">${esc(shortOf(ds))}</h4>` : "")}</section>`;
        }).join("");
    const report = ctx.reportUrl ? `<a class="small" href="${esc(ctx.reportUrl)}" target="_blank" rel="noopener">Report an issue ↗</a>` : "";
    el.innerHTML = `${head}<div class="issues-body">${add}${form}${list}${report}</div>`;
    wire();

    // What the issue is about; the type is shown separately (e.g. Missing infrastructure + Multi-use path).
    function title(i) {
      if (i.type === "missing" && !i.class) return `${sw(i.suggested_class)}${esc(label(i.suggested_class) ?? "")}`;
      const from = i.class ? `${sw(i.class)}${esc(label(i.class))}` : (i.source_class ? showWs(i.source_class) : "Whole place");
      return i.suggested_class ? `${from} <span class="muted">→</span> ${sw(i.suggested_class)}${esc(label(i.suggested_class))}` : from;
    }

    function item(i) {
      const sel = ctx.selected === i.id;
      const ex = i.examples || [];
      // Map-marker buttons, one per example location (numbered when there are several).
      const marker = (n) => `<svg viewBox="0 0 14 18" aria-hidden="true"><path d="M7 17.5C7 17.5 1 10.6 1 6.6a6 6 0 0 1 12 0c0 4-6 10.9-6 10.9z"/>
        ${ex.length > 1 ? `<text x="7" y="9.5">${n + 1}</text>` : `<circle cx="7" cy="6.6" r="2.2"/>`}</svg>`;
      const pins = ex.map((e, n) => `<button class="pin" data-ex="${n}" title="Show example ${n + 1} on the map">${marker(n)}</button>`).join("");
      // Card: type with example markers on the right; what it is;
      // note; Delete when selected.
      const del = sel && ctx.canSave && i.id ? `<button class="del" title="Delete issue">Delete</button>` : "";
      return `<li class="issue-item ${sel ? "selected" : ""}" data-id="${esc(i.id ?? "")}">
        <div class="issue-line"><span class="label label-${esc(i.type)}">${esc(types[i.type] ?? i.type)}</span>
          ${pins ? `<span class="pins">${pins}</span>` : ""}</div>
        <div class="issue-title">${title(i)}</div>
        ${i.note ? `<p>${esc(i.note)}</p>` : ""}
        ${del ? `<div class="issue-foot">${del}</div>` : ""}
      </li>`;
    }

    function draftForm() {
      const d = draft;
      const opt = (v, text, cur) => `<option value="${esc(v)}" ${v === (cur ?? "") ? "selected" : ""}>${esc(text)}</option>`;
      const classOpts = (cur, extra = []) => [opt("", "—", cur), ...classes.map((c) => opt(c.slug, c.label, cur)),
        ...extra.map(([v, t]) => opt(v, t, cur))].join("");
      const ex = d.examples?.[0];
      const ds = d.dataset || ctx.defaultDataset;
      const match = issues.find((i) => i.id && dsOf(i) === ds && i.type === d.type && (i.class ?? "") === (d.class ?? "")
        && (i.suggested_class ?? "") === (d.suggested_class ?? ""));
      const sv = ex && streetViewUrl(cfg, ex);
      return `<form class="issue-form">
        <div class="form-title">New issue${d.placeName ? ` · ${esc(d.placeName)}` : ""}</div>
        ${match ? `<div class="match">Same as an existing issue: <b>${title(match)}</b>
          ${ex ? `<button type="button" class="add-to" data-id="${esc(match.id)}">Add as example</button>` : ""}</div>` : ""}
        <label>Dataset <select name="dataset">${datasets.map((x) => opt(x.id, x.short, ds)).join("")}</select></label>
        <label>Type <select name="type">${Object.entries(types).map(([k, t]) => opt(k, t, d.type)).join("")}</select></label>
        <label>${esc(shortOf(ds))} says <select name="class">${classOpts(d.class)}</select></label>
        <label>Should be <select name="suggested_class">${classOpts(d.suggested_class, [["exclude", "Not cycling infrastructure"]])}</select></label>
        <label>Source class <input name="source_class" value="${esc(d.source_class ?? "")}" placeholder="optional"></label>
        <label>Note <textarea name="note" rows="2" placeholder="optional">${esc(d.note ?? "")}</textarea></label>
        ${ex ? `<div class="form-ex">Example: ${esc(ex.lat.toFixed(5))}, ${esc(ex.lng.toFixed(5))}
          ${sv ? ` · <a href="${esc(sv)}" target="_blank" rel="noopener">Street View ↗</a>` : ""}</div>` : ""}
        ${ctx.error ? `<p class="form-error">${esc(ctx.error)}</p>` : ""}
        <div class="form-buttons"><button type="button" class="cancel">Cancel</button>
          <button type="submit" ${ctx.canSave ? "" : "disabled title=\"Saving needs the local server (scripts/serve.py)\""}>Save</button></div>
      </form>`;
    }

    function wire() {
      el.querySelector(".issues-toggle").onclick = on.toggle;
      el.querySelector(".new-issue")?.addEventListener("click", on.newIssue);
      const f = el.querySelector(".issue-form");
      if (f) {
        f.oninput = () => on.draftChange(Object.fromEntries(new FormData(f)));
        f.onsubmit = (e) => { e.preventDefault(); on.save(Object.fromEntries(new FormData(f))); };
        f.querySelector(".cancel").onclick = on.cancel;
        f.querySelector(".add-to")?.addEventListener("click", (e) => on.addToExisting(e.target.dataset.id));
      }
      el.querySelectorAll(".issue-item").forEach((li) => {
        const issue = issues.find((i) => i.id === li.dataset.id);
        li.onclick = (e) => {
          const pin = e.target.closest(".pin");
          if (pin) return on.selectExample(issue, +pin.dataset.ex);
          if (e.target.closest(".del")) return confirm("Delete this issue?") && on.del(issue.id);
          on.select(ctx.selected === issue.id ? null : issue);
        };
      });
    }
  }

  return { render };
})();

// Street View link for an issue example (web.yaml links entry labelled "Open Street View").
function streetViewUrl(cfg, ex) {
  const link = (cfg.links || []).find((l) => /street view/i.test(l.label));
  if (!link || ex.lat == null) return null;
  const vars = { lat: ex.lat.toFixed(6), lng: ex.lng.toFixed(6), heading: Math.round(ex.heading ?? 0) };
  return link.url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
}
