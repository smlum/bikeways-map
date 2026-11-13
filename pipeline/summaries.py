"""Step 3: clean GeoParquet -> per-municipality km summaries (JSON) for city profiles."""

import json

import geopandas as gpd
import pandas as pd

from pipeline.lib import config


def _metadata(src: dict) -> dict:
    """Provenance per municipality, keyed by casefolded name."""
    meta = src.get("metadata")
    if not meta:
        return {}
    df = pd.read_csv(config.ROOT / meta["path"])
    df["_key"] = df[meta["key"]].str.casefold()
    return df.set_index("_key")[meta["fields"]].fillna("").astype(str).to_dict("index")


def run(source_id: str) -> None:
    src = config.source(source_id)
    order = [c["slug"] for c in config.classes()["classes"]]
    df = pd.DataFrame(gpd.read_parquet(config.clean_path(source_id)).drop(columns="geometry"))
    meta = _metadata(src)

    out = {"source": source_id, "dataset": src["dataset"], "vintage": src["vintage"],
           "label": src["label"], "municipalities": {}}

    for muni, g in df.groupby("municipality"):
        by_class = g.groupby("class")["length_km_source"].sum()
        by_class = by_class.reindex([c for c in order if c in by_class.index]
                                    + [c for c in by_class.index if c not in order])
        crosswalk = (g.groupby(["source_class", "class"], dropna=False)["length_km_source"]
                     .sum().reset_index().sort_values("length_km_source", ascending=False))
        out["municipalities"][muni] = {
            "province": g["province"].iloc[0],
            "total_km": round(g["length_km_source"].sum(), 1),
            "total_km_computed": round(g["length_km"].sum(), 1),
            "by_class_km": by_class.round(1).to_dict(),
            "source_class_crosswalk": [
                {"source_class": r.source_class, "class": r["class"], "km": round(r.length_km_source, 1)}
                for _, r in crosswalk.iterrows()
            ],
            "provenance": meta.get(muni.casefold(), {}),
        }

    path = config.build_dir() / "summaries" / f"{source_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"[summaries] -> {path.relative_to(config.ROOT)}")
