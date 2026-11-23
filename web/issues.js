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
    const form = draft ? draftForm() : "";
    const list = issues.length ? `<ul class="issue-list">${issues.map(item).join("")}</ul>` : "";
    const report = ctx.reportUrl ? `<a class="small" href="${esc(ctx.reportUrl)}" target="_blank" rel="noopener">Report an issue ↗</a>` : "";
    el.innerHTML = `${head}<div class="issues-body">${add}${form}${list}${report}</div>`;
    wire();

    function title(i) {
      if (i.type === "missing" && !i.class) return `Missing: ${sw(i.suggested_class)}${esc(label(i.suggested_class) ?? "")}`;
      const from = i.class ? `${sw(i.class)}${esc(label(i.class))}` : (i.source_class ? showWs(i.source_class) : "Whole place");
      return i.suggested_class ? `${from} <span class="muted">→</span> ${sw(i.suggested_class)}${esc(label(i.suggested_class))}` : from;
    }

    function item(i) {
      const sel = ctx.selected === i.id;
      const ex = i.examples || [];
      const pins = ex.map((e, n) => `<button class="pin" data-ex="${n}" title="Go to example ${n + 1}">${n + 1}</button>`).join("");
      const meta = [ctx.all && ctx.placeName(i.place), i.source_class && i.class ? `source class: ${i.source_class}` : null, i.date]
        .filter(Boolean).map(esc).join(" · ");
      return `<li class="issue-item ${sel ? "selected" : ""}" data-id="${esc(i.id ?? "")}">
        <div class="issue-line"><span class="issue-title">${title(i)}</span>
          <span class="label label-${esc(i.type)}">${esc(types[i.type] ?? i.type)}</span></div>
        ${i.note ? `<p>${esc(i.note)}</p>` : ""}
        <div class="issue-foot">${pins ? `<span class="pins">${pins}</span>` : ""}<span class="muted">${meta}</span>
          ${sel && ctx.canSave && i.id ? `<button class="del" title="Delete issue">Delete</button>` : ""}</div>
      </li>`;
    }

    function draftForm() {
      const d = draft;
      const opt = (v, text, cur) => `<option value="${esc(v)}" ${v === (cur ?? "") ? "selected" : ""}>${esc(text)}</option>`;
      const classOpts = (cur, extra = []) => [opt("", "—", cur), ...classes.map((c) => opt(c.slug, c.label, cur)),
        ...extra.map(([v, t]) => opt(v, t, cur))].join("");
      const ex = d.examples?.[0];
      const match = issues.find((i) => i.id && i.type === d.type && (i.class ?? "") === (d.class ?? "")
        && (i.suggested_class ?? "") === (d.suggested_class ?? ""));
      const sv = ex && streetViewUrl(cfg, ex);
      return `<form class="issue-form">
        <div class="form-title">New issue${d.placeName ? ` · ${esc(d.placeName)}` : ""}</div>
        ${match ? `<div class="match">Same as an existing issue: <b>${title(match)}</b>
          ${ex ? `<button type="button" class="add-to" data-id="${esc(match.id)}">Add as example</button>` : ""}</div>` : ""}
        <label>Type <select name="type">${Object.entries(types).map(([k, t]) => opt(k, t, d.type)).join("")}</select></label>
        <label>${esc(d.aLabel)} says <select name="class">${classOpts(d.class)}</select></label>
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
