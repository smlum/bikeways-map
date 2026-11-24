// Issues panel (right): the selected place's known issues, and the form for a new one, prefilled from
// a clicked segment ("Add issue" in its popup). An issue is usually a place + class pair ("bike path
// that should be multi-use path"); clicked segments are its examples. Pure rendering; app.js owns
// state, saving (scripts/serve.py issues API) and the map.

const IssuesPanel = (() => {
  // "Anonymous Otter" etc., for people who'd rather not give a name.
  const ANIMALS = ["Beaver", "Moose", "Loon", "Otter", "Lynx", "Heron", "Caribou", "Puffin", "Marten", "Bison",
    "Orca", "Hare", "Owl", "Fox", "Elk", "Panda"];
  const anonymousName = () => `Anonymous ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;
  // Notes: letters (accented too), digits, spaces and , . / ? ! ' - ( ) : ; only, up to NOTE_MAX.
  const NOTE_MAX = 200, BY_MAX = 40;
  const NOTE_BAD = /[^\p{L}\p{M}\p{N} ,./?!'’\-():;]/gu;

  // ctx: {cfg, title, issues, draft, selected, canSave, canAdd, error, open, onMap, by, places, reportUrl, placeName(id),
  //       on: {toggle, toggleOnMap, newIssue, select, selectExample, save, cancel, addToExisting, del, draftChange}}
  function render(el, ctx) {
    const { cfg, issues, draft, on } = ctx;
    const classes = cfg.classes.classes;
    const label = (slug) => slug === "exclude" ? "Not cycling infrastructure"
      : classes.find((c) => c.slug === slug)?.label ?? slug;
    const sw = (slug) => slug && slug !== "exclude"
      ? `<span class="swatch" style="background:${classInfo(cfg, slug).color}"></span>` : "";
    const types = cfg.issue_types || {};

    // Always shown, open or not: title, count and place; Add issue "as <name>"; Show / Hide issues.
    // The name is asked once (or Anonymous), then shown next to Add issue and editable in place;
    // it's remembered in this browser.
    const head = `<header class="issues-head">
        <h2>Issues</h2>${issues.length ? `<span class="count">${issues.length}</span>` : ""}
        <span class="muted issues-place">${esc(ctx.title)}</span>
        <label class="on-map" title="Show issue locations on the map"><input type="checkbox" ${ctx.onMap ? "checked" : ""}> On map</label>
      </header>`;
    const by = !ctx.canSave ? "" : ctx.by
      ? `<label class="by-name" title="Name saved with your issues (this browser only)">as
          <input class="by-input" value="${esc(ctx.by)}" maxlength="${BY_MAX}" size="${Math.max(4, ctx.by.length)}" aria-label="Your name"></label>`
      : `<label class="by-name">as <input class="by-input by-new" maxlength="${BY_MAX}" size="9" placeholder="your name" aria-label="Your name"></label>
          <button type="button" class="by-anon">Anonymous</button>`;
    const addBtn = !draft && ctx.canAdd ? `<button class="new-issue">Add issue</button>` : "";
    const toggle = issues.length ? `<button class="issues-toggle">${ctx.open ? "Hide issues" : "Show issues"}</button>` : "";
    const top = `<div class="issues-top">
        ${addBtn || by ? `<div class="issues-add">${addBtn}${by}</div>` : ""}
        ${ctx.canAdd && !ctx.canSave ? `<p class="muted small">Read-only: saving needs the local server (scripts/serve.py).</p>` : ""}
        ${toggle}</div>`;
    // One section per dataset (baseline first); issues without a dataset belong to the baseline.
    const datasets = ctx.datasets || [];
    const dsOf = (i) => i.dataset || ctx.defaultDataset;
    const shortOf = (id) => datasets.find((d) => d.id === id)?.short ?? id;
    const form = draft ? draftForm() : "";
    if (!ctx.open && !draft) { el.innerHTML = head + top; wire(); return; }
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
    const body = form + (ctx.open ? list + report : "");
    el.innerHTML = `${head}${top}${body ? `<div class="issues-body">${body}</div>` : ""}`;
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
      // "Example" buttons, one per example location ("Example 1", "Example 2"… when there are several).
      const pins = ex.map((e, n) => `<button class="pin" data-ex="${n}" title="Show on the map">Example${ex.length > 1 ? ` ${n + 1}` : ""}</button>`).join("");
      // Card: type with example buttons on the right; what it is;
      // note; Delete when selected.
      const del = sel && ctx.canSave && i.id ? `<button class="del" title="Delete issue">Delete</button>` : "";
      return `<li class="issue-item ${sel ? "selected" : ""}" data-id="${esc(i.id ?? "")}">
        <div class="issue-line"><span class="label label-${esc(i.type)}">${esc(types[i.type] ?? i.type)}</span>
          ${i.by ? `<span class="issue-by">${esc(i.by)}</span>` : ""}
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
      const match = d.place && issues.find((i) => i.id && i.place === d.place && dsOf(i) === ds && i.type === d.type && (i.class ?? "") === (d.class ?? "")
        && (i.suggested_class ?? "") === (d.suggested_class ?? ""));
      const sv = ex && streetViewUrl(cfg, ex);
      return `<form class="issue-form">
        <div class="form-title">New issue${d.placeName ? ` · ${esc(d.placeName)}` : ""}</div>
        ${d.placeName ? "" : `<label>City <select name="place">${[opt("", "Choose a city", d.place),
          ...(ctx.places || []).map((p) => opt(p.id, p.name, d.place))].join("")}</select></label>`}
        ${match ? `<div class="match">Same as an existing issue: <b>${title(match)}</b>
          ${ex ? `<button type="button" class="add-to" data-id="${esc(match.id)}">Add as example</button>` : ""}</div>` : ""}
        <label>Dataset <select name="dataset">${datasets.map((x) => opt(x.id, x.short, ds)).join("")}</select></label>
        <label>Type <select name="type">${Object.entries(types).map(([k, t]) => opt(k, t, d.type)).join("")}</select></label>
        <label>${esc(shortOf(ds))} says <select name="class">${classOpts(d.class)}</select></label>
        <label>Should be <select name="suggested_class">${classOpts(d.suggested_class, [["exclude", "Not cycling infrastructure"]])}</select></label>
        <label>Source class <input name="source_class" value="${esc(d.source_class ?? "")}" placeholder="optional"></label>
        <label>Note <textarea name="note" rows="2" maxlength="${NOTE_MAX}" placeholder="optional, up to ${NOTE_MAX} characters">${esc(d.note ?? "")}</textarea></label>
        ${ex ? `<div class="form-ex">Example: ${esc(ex.lat.toFixed(5))}, ${esc(ex.lng.toFixed(5))}
          ${sv ? ` · <a href="${esc(sv)}" target="_blank" rel="noopener">Street View ↗</a>` : ""}</div>` : ""}
        ${ctx.error ? `<p class="form-error">${esc(ctx.error)}</p>` : ""}
        <div class="form-buttons"><button type="button" class="cancel">Cancel</button>
          <button type="submit" ${ctx.canSave ? "" : "disabled title=\"Saving needs the local server (scripts/serve.py)\""}>Save</button></div>
      </form>`;
    }

    function wire() {
      el.querySelector(".issues-toggle")?.addEventListener("click", on.toggle);
      el.querySelector(".on-map input").onchange = (e) => on.toggleOnMap(e.target.checked);
      el.querySelectorAll(".by-input").forEach((inp) => inp.addEventListener("input", () => {
        const v = inp.value.replace(NOTE_BAD, "");
        if (v !== inp.value) inp.value = v;
      }));
      const byInput = el.querySelector(".by-input");
      if (byInput) byInput.onchange = () => { // Enter or leaving the box; empty -> anonymous (or unchanged if new)
        const v = byInput.value.trim();
        if (v || ctx.by) on.setBy(v || anonymousName(), false);
      };
      el.querySelector(".by-anon")?.addEventListener("click", () => on.setBy(anonymousName()));
      el.querySelector(".new-issue")?.addEventListener("click", on.newIssue);
      const f = el.querySelector(".issue-form");
      if (f) {
        f.note.addEventListener("input", () => { // same rule as the server (scripts/serve.py)
          const v = f.note.value.replace(NOTE_BAD, "");
          if (v !== f.note.value) f.note.value = v;
        });
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

  return { render, anonymousName };
})();

// Street View link for an issue example (web.yaml links entry labelled "Open Street View").
function streetViewUrl(cfg, ex) {
  const link = (cfg.links || []).find((l) => /street view/i.test(l.label));
  if (!link || ex.lat == null) return null;
  const vars = { lat: ex.lat.toFixed(6), lng: ex.lng.toFixed(6), heading: Math.round(ex.heading ?? 0) };
  return link.url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
}
