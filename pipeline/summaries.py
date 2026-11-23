"""Step 3: clean GeoParquet -> per-place summaries (JSON) for city profiles.

All lengths are km as published (length_km_source); recomputed totals are included for reference.
Place names across files are resolved through config/places.yaml.
"""

import json

import geopandas as gpd
import pandas as pd

from pipeline.lib import config, places
from pipeline.lib.text import name_key


def _metadata(source_id: str, src: dict) -> dict:
    """{place_id: provenance fields}. A source-wide `provenance` block applies to every place."""
    if "provenance" in src:
        return {pid: dict(src["provenance"]) for pid in places.registry()}
    meta = src.get("metadata")
    if not meta:
        return {}
    df = pd.read_csv(config.ROOT / meta["path"]).fillna("")
    df = df.set_index(meta["key"])[meta["fields"]].astype(str).apply(lambda c: c.str.strip())
    return {pid: df.loc[name].to_dict()
            for pid, name in places.names(source_id, "metadata").items() if name in df.index}


def _dictionary(source_id: str, src: dict) -> dict:
    """{place_id: DataFrame[source_class, _sc, dict_class, example_url]}."""
    d = src.get("dictionary")
    if not d:
        return {}
    # Keep literal strings like "nan"/"none" as-is: they are values in the source dictionary.
    df = pd.read_csv(config.ROOT / d["path"], keep_default_na=False, na_values=[""])
    df = pd.DataFrame({
        "muni": df[d["municipality"]],
        "source_class": df[d["source_class"]].astype(str),
        "dict_class": df[d["class"]],
        "example_url": df[d["example_url"]].fillna("").str.strip() if d.get("example_url") else "",
    })
    df["_sc"] = name_key(df["source_class"])
    df = df.drop_duplicates(["muni", "_sc"])
    return {pid: df[df["muni"] == name] for pid, name in places.names(source_id, "dictionary").items()}


def _crosswalk(g: pd.DataFrame, dic: pd.DataFrame | None) -> list[dict]:
    """Rows of class -> source class (-> secondary class) with km, plus dictionary-only classes."""
    dic = dic if dic is not None else pd.DataFrame(columns=["_sc", "source_class", "dict_class", "example_url"])
    dic_by_sc = dic.set_index("_sc")
    g = g.assign(_sc=name_key(g["source_class"]))
    if "source_class_secondary" not in g.columns:
        g["source_class_secondary"] = None
    n_classes = g.groupby("_sc")["class"].nunique()
    sec = g["source_class_secondary"].fillna("\0")
    by_spelling = g.groupby(["_sc", "source_class"])["class"].nunique().groupby("_sc").max() == 1
    by_secondary = g.assign(_sec=sec).groupby(["_sc", "_sec"])["class"].nunique().groupby("_sc").max() == 1
    n_spellings = g.groupby("_sc")["source_class"].nunique()

    def split_reason(k):
        """Why one (normalised) source class maps to several CAN-BICS classes, if it does."""
        if n_classes[k] <= 1:
            return None
        if n_spellings[k] > 1 and by_spelling[k]:
            return "spelling"   # e.g. trailing whitespace variants mapped differently
        if by_secondary[k]:
            return "secondary"
        return "unexplained"
    has_secondary = g.groupby("_sc")["source_class_secondary"].apply(lambda s: s.notna().any())

    rows = []
    grouped = g.groupby(["class", "source_class"], dropna=False)["length_km_source"].sum()
    for (cls, sc), km in grouped.sort_values(ascending=False).items():
        k = name_key(pd.Series([sc])).iloc[0]
        d = dic_by_sc.loc[k] if k in dic_by_sc.index else None
        sub = g[(g["class"] == cls) & (g["source_class"] == sc)]
        secondary = []
        if has_secondary[k]:
            s = sub.groupby(sub["source_class_secondary"].fillna("\0"))["length_km_source"].sum()
            secondary = [{"value": None if v == "\0" else v, "km": round(float(x), 1)}
                         for v, x in s.sort_values(ascending=False).items()]
        rows.append({
            "source_class": str(sc),
            "class": cls,
            "km": round(float(km), 1),
            "in_data": True,
            # Same source class assigned to >1 CAN-BICS class: "secondary" | "spelling" | "unexplained" | None
            "split": split_reason(k),
            "secondary": secondary,
            "dictionary_class": d["dict_class"] if d is not None and pd.notna(d["dict_class"]) else None,
            "example_url": d["example_url"] if d is not None else "",
        })

    for _, d in dic[~dic["_sc"].isin(set(g["_sc"]))].iterrows():
        rows.append({
            "source_class": d["source_class"], "class": d["dict_class"] if pd.notna(d["dict_class"]) else None,
            "km": 0.0, "in_data": False, "split": None, "secondary": [],
            "dictionary_class": d["dict_class"] if pd.notna(d["dict_class"]) else None,
            "example_url": d["example_url"],
        })
    return rows


def run(source_id: str) -> None:
    src = config.source(source_id)
    reg = places.registry()
    order = [c["slug"] for c in config.classes()["classes"]]
    gdf = gpd.read_parquet(config.clean_path(source_id))
    df = pd.DataFrame(gdf.drop(columns="geometry"))
    meta = _metadata(source_id, src)
    dictionary = _dictionary(source_id, src)

    out = {"source": source_id, "dataset": src["dataset"], "vintage": src["vintage"],
           "label": src["label"], "places": {}}

    area_csds = places.csds()

    def area_block(pid, g):
        """km inside the place's profile area (its CSD list), for like-for-like comparison across sources."""
        uids = set(area_csds.get(pid, []))
        if not uids or "csd_uid" not in g.columns:
            return None
        inside = g[g["csd_uid"].isin(uids)]
        by = inside.groupby("class")["length_km_source"].sum()
        names = {str(c["uid"]): c["name"] for c in reg[pid].get("csds", [])}
        return {
            "csds": [{"uid": u, "name": names.get(u, u)} for u in sorted(uids)],
            "total_km": round(inside["length_km_source"].sum(), 1),
            "outside_km": round(g["length_km_source"].sum() - inside["length_km_source"].sum(), 1),
            "by_class_km": by.reindex([c for c in order if c in by.index]).round(1).to_dict(),
        }

    for pid, g in df.dropna(subset=["place"]).groupby("place"):
        by_class = g.groupby("class")["length_km_source"].sum()
        by_class = by_class.reindex([c for c in order if c in by_class.index]
                                    + [c for c in by_class.index if c not in order])
        out["places"][pid] = {
            "name": reg[pid]["name"],
            "province": reg[pid].get("province"),
            "municipality": g["municipality"].iloc[0] if "municipality" in g.columns else None,
            "area": area_block(pid, g),
            "bounds": [round(v, 5) for v in gdf.loc[g.index].total_bounds],
            "total_km": round(g["length_km_source"].sum(), 1),
            "total_km_computed": round(g["length_km"].sum(), 1),
            "by_class_km": by_class.round(1).to_dict(),
            "crosswalk": _crosswalk(g, dictionary.get(pid)),
            "provenance": meta.get(pid, {}),
        }

    path = config.build_dir() / "summaries" / f"{source_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False, allow_nan=False))
    print(f"[summaries] -> {path.relative_to(config.ROOT)}")
