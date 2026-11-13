"""Step 3: clean GeoParquet -> per-municipality summaries (JSON) for city profiles.

All lengths are km as published (length_km_source); recomputed totals are included for reference.
"""

import json

import geopandas as gpd
import pandas as pd

from pipeline.lib import config
from pipeline.lib.text import name_key as _key, name_key_str


def _metadata(src: dict) -> dict:
    """Provenance per municipality, keyed by normalised name."""
    meta = src.get("metadata")
    if not meta:
        return {}
    df = pd.read_csv(config.ROOT / meta["path"])
    df["_key"] = _key(df[meta["key"]])
    return df.set_index("_key")[meta["fields"]].fillna("").astype(str).to_dict("index")


def _dictionary(src: dict) -> pd.DataFrame:
    """Published source_class -> class assignments, normalised columns."""
    d = src.get("dictionary")
    if not d:
        return pd.DataFrame(columns=["_muni", "_sc", "source_class", "dict_class", "example_url"])
    # Keep literal strings like "nan"/"none" as-is: they are values in the source dictionary.
    df = pd.read_csv(config.ROOT / d["path"], keep_default_na=False, na_values=[""])
    return pd.DataFrame({
        "_muni": _key(df[d["municipality"]]),
        "_sc": _key(df[d["source_class"]]),
        "source_class": df[d["source_class"]].astype(str),
        "dict_class": df[d["class"]],
        "example_url": df[d["example_url"]].fillna("") if d.get("example_url") else "",
    })


def _crosswalk(g: pd.DataFrame, dict_rows: pd.DataFrame) -> list[dict]:
    """Source class -> class with km, merged with the published dictionary.

    Includes dictionary entries with no km in the data (e.g. classes excluded as not_classified).
    """
    km = (g.groupby(["source_class", "class"], dropna=False)["length_km_source"].sum()
          .reset_index())
    km["_sc"] = _key(km["source_class"])
    dict_rows = dict_rows.drop_duplicates("_sc").rename(columns={"source_class": "dict_source_class"})
    merged = km.merge(dict_rows, on="_sc", how="outer")
    merged["source_class"] = merged["source_class"].fillna(merged["dict_source_class"])
    merged = merged.sort_values("length_km_source", ascending=False, na_position="last")

    rows = []
    for _, r in merged.iterrows():
        in_data = pd.notna(r["length_km_source"])
        rows.append({
            "source_class": str(r["source_class"]),
            "class": r["class"] if in_data else (r["dict_class"] if pd.notna(r["dict_class"]) else None),
            "km": round(float(r["length_km_source"]), 1) if in_data else 0.0,
            "in_data": bool(in_data),
            "dictionary_class": r["dict_class"] if pd.notna(r["dict_class"]) else None,
            "example_url": r["example_url"] if isinstance(r["example_url"], str) else "",
        })
    return rows


def run(source_id: str) -> None:
    src = config.source(source_id)
    order = [c["slug"] for c in config.classes()["classes"]]
    gdf = gpd.read_parquet(config.clean_path(source_id))
    df = pd.DataFrame(gdf.drop(columns="geometry"))
    meta = _metadata(src)
    dictionary = _dictionary(src)

    out = {"source": source_id, "dataset": src["dataset"], "vintage": src["vintage"],
           "label": src["label"], "municipalities": {}}

    for muni, g in df.groupby("municipality"):
        by_class = g.groupby("class")["length_km_source"].sum()
        by_class = by_class.reindex([c for c in order if c in by_class.index]
                                    + [c for c in by_class.index if c not in order])
        out["municipalities"][muni] = {
            "province": g["province"].iloc[0],
            "bounds": [round(v, 5) for v in gdf.loc[g.index].total_bounds],
            "total_km": round(g["length_km_source"].sum(), 1),
            "total_km_computed": round(g["length_km"].sum(), 1),
            "by_class_km": by_class.round(1).to_dict(),
            "crosswalk": _crosswalk(g, dictionary[dictionary["_muni"] == name_key_str(muni)]),
            "provenance": meta.get(name_key_str(muni), {}),
        }

    path = config.build_dir() / "summaries" / f"{source_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False, allow_nan=False))
    print(f"[summaries] -> {path.relative_to(config.ROOT)}")
