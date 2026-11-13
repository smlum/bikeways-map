// Cross-city comparison table. Reads the same data/config.json + summaries as the map.

const COMFORT = [
  ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["non_conforming", "Non-conf."],
];

main();

async function main() {
  const cfg = await (await fetch("data/config.json")).json();
  const classes = cfg.classes.classes;
  const state = { rows: [], sort: { key: "total", dir: -1 }, unit: "km", q: "" };
  const $ = (id) => document.getElementById(id);

  cfg.sources.forEach((s) => $("source").add(new Option(s.label, s.id)));
  $("source").onchange = () => load(cfg.sources.find((s) => s.id === $("source").value));
  $("q").oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); render(); };
  document.querySelectorAll(".seg-toggle button").forEach((b) => (b.onclick = () => {
    state.unit = b.dataset.unit;
    document.querySelectorAll(".seg-toggle button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    render();
  }));

  // Columns: key, label, value(row), kind ("text" | "num" | "measure"), optional colour swatch.
  const columns = [
    { key: "name", label: "City", kind: "text", value: (r) => r.name },
    { key: "province", label: "Prov.", kind: "text", value: (r) => r.province.toUpperCase() },
    { key: "total", label: "Total km", kind: "num", value: (r) => r.total },
    { key: "bar", label: "Mix", kind: "bar", value: () => 0 },
    ...COMFORT.map(([k, label]) => ({ key: `comfort_${k}`, label, kind: "measure", group: "Comfort",
      value: (r) => r.comfort[k] || 0 })),
    ...classes.map((c) => ({ key: `class_${c.slug}`, label: c.label, kind: "measure", group: "CAN-BICS class",
      color: c.color, value: (r) => r.byClass[c.slug] || 0 })),
    { key: "n_source", label: "Source classes", kind: "num", value: (r) => r.nSource },
    { key: "flags", label: "Flags", kind: "num", value: (r) => r.flags.length },
    { key: "year", label: "Data year", kind: "text", value: (r) => r.year },
  ];

  async function load(src) {
    const summary = await (await fetch(`data/${src.summary}`)).json();
    state.rows = Object.entries(summary.places).map(([id, p]) => toRow(id, p));
    const km = state.rows.reduce((s, r) => s + r.total, 0);
    $("subtitle").textContent = `${summary.label} · ${state.rows.length} places · ${fmt(km)} km`;
    render();
  }

  function toRow(id, p) {
    const comfort = {};
    classes.forEach((c) => (comfort[c.comfort] = (comfort[c.comfort] || 0) + (p.by_class_km[c.slug] || 0)));
    const inData = p.crosswalk.filter((r) => r.in_data);
    const flags = [];
    const splits = new Set(inData.filter((r) => r.split).map((r) => `${r.source_class.trim()} (${r.split})`));
    splits.forEach((s) => flags.push(`Split: ${s}`));
    inData.filter((r) => r.dictionary_class && r.dictionary_class !== r.class)
      .forEach((r) => flags.push(`≠ dictionary: ${r.source_class.trim()}`));
    const excluded = p.crosswalk.filter((r) => !r.in_data).length;
    if (excluded) flags.push(`${excluded} source class${excluded > 1 ? "es" : ""} excluded`);
    return {
      id, name: p.name, province: p.province || "", total: p.total_km, byClass: p.by_class_km, comfort,
      nSource: new Set(inData.map((r) => r.source_class)).size, flags,
      year: p.provenance?.year_updated || "",
    };
  }

  function render() {
    const { key, dir } = state.sort;
    const col = columns.find((c) => c.key === key);
    const rows = state.rows
      .filter((r) => !state.q || r.name.toLowerCase().includes(state.q) || r.province.includes(state.q))
      .sort((a, b) => {
        let va = col.value(a), vb = col.value(b);
        if (col.kind === "measure" && state.unit === "pct") { va /= a.total || 1; vb /= b.total || 1; }
        return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
      });
    const maxTotal = Math.max(...state.rows.map((r) => r.total), 1);

    // Two header rows: group labels over measure columns.
    const groups = [];
    columns.forEach((c) => {
      const g = c.group || "";
      if (groups.length && groups.at(-1).g === g) groups.at(-1).n++;
      else groups.push({ g, n: 1 });
    });
    const head1 = groups.map(({ g, n }) => `<th colspan="${n}" class="group-h">${esc(g)}</th>`).join("");
    const head2 = columns.map((c) => {
      const sorted = c.key === key ? (dir < 0 ? " ↓" : " ↑") : "";
      const sw = c.color ? `<span class="swatch" style="background:${c.color}"></span>` : "";
      return `<th class="${c.kind} ${c.key === key ? "sorted" : ""}" data-key="${c.key}" ${c.kind === "bar" ? "" : 'tabindex="0"'}>
        <span>${sw}${esc(c.label)}${sorted}</span></th>`;
    }).join("");

    const body = rows.map((r) => `<tr data-id="${r.id}" tabindex="0">${columns.map((c) => cell(c, r, maxTotal)).join("")}</tr>`).join("");
    $("cities").innerHTML = `<thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${body}</tbody>`;

    $("cities").querySelectorAll("th[data-key]").forEach((th) => {
      if (th.classList.contains("bar")) return;
      const go = () => {
        const k = th.dataset.key;
        const c = columns.find((x) => x.key === k);
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : c.kind === "text" ? 1 : -1 };
        render();
      };
      th.onclick = go;
      th.onkeydown = (e) => e.key === "Enter" && go();
    });
    $("cities").querySelectorAll("tbody tr").forEach((tr) => {
      const go = () => (location.href = `index.html?city=${tr.dataset.id}`);
      tr.onclick = (e) => !e.target.closest("details") && go();
      tr.onkeydown = (e) => e.key === "Enter" && go();
    });
  }

  function cell(c, r, maxTotal) {
    if (c.key === "bar") {
      const segs = classes.filter((k) => r.byClass[k.slug]).map((k) =>
        `<span style="flex:${r.byClass[k.slug]};background:${k.color}" title="${esc(k.label)}: ${fmt(r.byClass[k.slug])} km"></span>`).join("");
      return `<td class="bar"><div class="mix" style="width:${state.unit === "pct" ? 100 : Math.max(8, (r.total / maxTotal) * 100)}%">${segs}</div></td>`;
    }
    if (c.key === "flags") {
      return `<td class="num">${r.flags.length ? `<details><summary>${r.flags.length}</summary><ul>${r.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>` : '<span class="muted">–</span>'}</td>`;
    }
    const v = c.value(r);
    if (c.kind === "measure") {
      if (!v) return `<td class="num muted">–</td>`;
      return `<td class="num">${state.unit === "pct" ? `${Math.round((v / r.total) * 100)}%` : fmt(v)}</td>`;
    }
    if (c.kind === "num") return `<td class="num">${fmt(v)}</td>`;
    return `<td class="${c.key === "name" ? "name" : ""}">${esc(v)}</td>`;
  }

  load(cfg.sources[0]);
}

function fmt(v) { return v < 10 && v % 1 ? v.toFixed(1) : Math.round(v).toLocaleString(); }
function esc(v) {
  return String(v ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}
