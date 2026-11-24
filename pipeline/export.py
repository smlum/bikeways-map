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
    # Dissolve before simplifying: simplified neighbours no longer share edges, leaving sliver holes.
    area = g.dissolve("place").reset_index()[["place", "geometry"]]
    area["geometry"] = area.geometry.simplify(simplify_m)
    g["geometry"] = g.geometry.simplify(simplify_m)
    g["kind"] = "csd"
    area["kind"] = "area"
    area["name"] = area["place"].map(lambda p: reg[p]["name"])
    out = gpd.GeoDataFrame(pd.concat([g, area], ignore_index=True), crs=b.crs).to_crs(4326)
    out.geometry = out.geometry.set_precision(1e-5)
    out[["place", "kind", "name", "csd_uid", "geometry"]].to_file(path, driver="GeoJSON", engine="pyogrio")


def export_canada(path, simplify_m: float = 500, min_km2: float = 20) -> None:
    """Outline of Canada (dissolved CSDs, incl. coastal water to the international line), for hiding
    basemap labels elsewhere. Simplified to ~simplify_m, islets under min_km2 dropped (~36 KB).
    Built once: delete the file to rebuild."""
    if path.exists():
        return
    import shapely
    b = csd.boundaries()
    u = shapely.union_all(b.geometry.simplify(200).buffer(0).values).simplify(simplify_m)
    g = shapely.MultiPolygon([shapely.Polygon(p.exterior) for p in getattr(u, "geoms", [u]) if p.area > min_km2 * 1e6])
    out = gpd.GeoSeries([g], crs=b.crs).to_crs(4326).make_valid()
    out.to_file(path, driver="GeoJSON", engine="pyogrio", layer_options={"COORDINATE_PRECISION": 4})


ISSUE_TYPES ={"wrong_class", "missing", "other"}


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
    export_canada(WEB_DATA / "canada.geojson")

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

    # web/data holds exactly what the app uses: drop files from sources or pairs no longer configured.
    keep = {"config.json", "areas.geojson", "canada.geojson"}
    keep |= {f for m in manifest for f in (m["tiles"], m["summary"]) if f}
    keep |= {f for c in comparisons for f in (c["tiles"], c["summary"])}
    for f in WEB_DATA.iterdir():
        if f.is_file() and f.name not in keep:
            f.unlink()
            print(f"[export] removed stale web/data/{f.name}")
    print(f"[export] -> web/data/ ({len(manifest)} sources, {len(out['issues'])} issues)")
