"""Final step: copy build outputs + config into web/data/ for the app."""

import json
import shutil

import geopandas as gpd
import pandas as pd
import pyarrow.parquet as pq

from pipeline.lib import config, csd, places

WEB_DATA = config.ROOT / "web" / "data"


def export_areas(path, simplify_m: float = 25) -> None:
    """Profile areas -> GeoJSON: one feature per CSD (kind=csd) + one dissolved outline per place (kind=area)."""
    b = csd.boundaries().set_index("csd_uid")
    reg = places.registry()
    rows = [{"place": pid, "csd_uid": u, "name": b.at[u, "csd_name"], "geometry": b.at[u, "geometry"]}
            for pid, uids in places.csds().items() for u in uids if u in b.index]
    g = gpd.GeoDataFrame(rows, crs=b.crs)
    g["geometry"] = g.geometry.simplify(simplify_m)
    g["kind"] = "csd"
    area = g.dissolve("place").reset_index()[["place", "geometry"]]
    area["kind"] = "area"
    area["name"] = area["place"].map(lambda p: reg[p]["name"])
    out = gpd.GeoDataFrame(pd.concat([g, area], ignore_index=True), crs=b.crs).to_crs(4326)
    out.geometry = out.geometry.set_precision(1e-5)
    out[["place", "kind", "name", "csd_uid", "geometry"]].to_file(path, driver="GeoJSON", engine="pyogrio")


ISSUE_TYPES = {"wrong_class", "missing", "other"}


def load_issues(sources: list[str]) -> list[dict]:
    """config/issues.yaml, checked against places, datasets and each place's source classes."""
    reg = places.registry()
    slugs = {c["slug"] for c in config.classes()["classes"]} | {"exclude"}
    crosswalks = {}  # dataset -> {place: {source_class, ...}}
    out = []
    for i, raw in enumerate(config.load("issues").get("issues") or []):
        issue = {"dataset": "ccnd_2024", **raw}
        where = f"issues.yaml #{i + 1} ({issue.get('place')})"
        problems = [
            issue.get("place") not in reg and "unknown place",
            issue["dataset"] not in sources and f"dataset {issue['dataset']} not exported",
            issue.get("type") not in ISSUE_TYPES and f"type must be one of {sorted(ISSUE_TYPES)}",
            issue.get("class") not in (None, *slugs) and f"unknown class {issue['class']}",
            issue.get("suggested_class") not in (None, *slugs) and f"unknown suggested_class {issue['suggested_class']}",
        ]
        if any(problems):
            print(f"[export] skip {where}: {'; '.join(p for p in problems if p)}")
            continue
        if issue.get("source_class") is not None:
            if issue["dataset"] not in crosswalks:
                path = config.build_dir() / "summaries" / f"{issue['dataset']}.json"
                summary = json.loads(path.read_text()) if path.exists() else {"places": {}}
                crosswalks[issue["dataset"]] = {pid: {r["source_class"] for r in p["crosswalk"]}
                                                for pid, p in summary["places"].items()}
            if issue["source_class"] not in crosswalks[issue["dataset"]].get(issue["place"], set()):
                print(f"[export] warning {where}: source class '{issue['source_class']}' not in the data")
        if "date" in issue:
            issue["date"] = str(issue["date"])
        out.append(issue)
    return out


def run() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    build = config.build_dir()

    manifest = []
    for source_id, src in config.sources().items():
        tiles = build / "tiles" / f"{source_id}.pmtiles"
        summary = build / "summaries" / f"{source_id}.json"
        if not tiles.exists():
            print(f"[export] skip {source_id}: no tiles")
            continue
        shutil.copy2(tiles, WEB_DATA / tiles.name)
        if summary.exists():
            shutil.copy2(summary, WEB_DATA / summary.name)
        manifest.append({
            "id": source_id, "dataset": src["dataset"], "vintage": src["vintage"],
            "label": src["label"], "short": src.get("short", src["label"]), "tiles": tiles.name,
            "summary": summary.name if summary.exists() else None,
            "attribution": src.get("attribution", ""),
            "osm_snapshot": src.get("osm_snapshot"),
            # Columns present in this source, so the app only shows popup fields/links that exist.
            "fields": pq.read_schema(config.clean_path(source_id)).names,
        })

    export_areas(WEB_DATA / "areas.geojson")

    from pipeline.compare import pair_id
    comparisons = []
    for pair in config.load("comparisons").get("pairs", []):
        pid = pair_id(pair["a"], pair["b"])
        tiles, summary = build / "tiles" / f"{pid}.pmtiles", build / "summaries" / f"{pid}.json"
        if not tiles.exists():
            continue
        shutil.copy2(tiles, WEB_DATA / tiles.name)
        shutil.copy2(summary, WEB_DATA / summary.name)
        comparisons.append({"id": pid, "a": pair["a"], "b": pair["b"], "tiles": tiles.name, "summary": summary.name})

    out = {
        **config.load("web"),
        "layer": config.pipeline()["tiles"]["layer"],
        "classes": config.classes(),
        "sources": manifest,
        "comparisons": comparisons,
        "issues": load_issues([m["id"] for m in manifest]),
    }
    (WEB_DATA / "config.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"[export] -> web/data/ ({len(manifest)} sources, {len(out['issues'])} issues)")
