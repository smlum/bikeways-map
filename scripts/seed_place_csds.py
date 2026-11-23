"""Seed each place's CSD list (places.yaml `csds`) from where its CCND network lies.

Rule: a CSD joins a place if (a) the place has the most network km of any place in that CSD, and
(b) the place's km density there (km per km² of land) is at least THRESHOLD x its density in its
main CSD. This keeps e.g. Montréal's small island CSDs but drops rural spill-over (Ottawa -> Beckwith).
Places that already have `csds` are left alone (edit by hand). Prints the decisions for review.

    python scripts/seed_place_csds.py ccnd_2024 [threshold=0.1]
"""

import sys
from pathlib import Path

import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline.lib import config, csd  # noqa: E402

HEADER_END = "places:\n"


def main(source_id: str, threshold: float) -> None:
    gdf = pd.read_parquet(config.clean_path(source_id), columns=["place", "csd_uid", "length_km_source"])
    b = csd.boundaries().drop(columns="geometry").set_index("csd_uid")

    km = gdf.dropna(subset=["csd_uid"]).groupby(["csd_uid", "place"])["length_km_source"].sum().reset_index()
    km["owner"] = km.groupby("csd_uid")["length_km_source"].transform("max") == km["length_km_source"]
    km["density"] = km["length_km_source"] / km["csd_uid"].map(b["area_km2"]).clip(lower=0.01)

    path = config.CONFIG_DIR / "places.yaml"
    text = path.read_text()
    header, body = text.split(HEADER_END, 1)
    reg = yaml.safe_load(HEADER_END + body)

    for pid, g in km.groupby("place"):
        place = reg["places"][pid]
        main = g.loc[g["length_km_source"].idxmax()]
        keep = g[g["owner"] & (g["density"] >= threshold * main["density"])]
        dropped = g[~g.index.isin(keep.index)]
        if "csds" in place:
            continue
        place["csds"] = [{"uid": str(u), "name": b.at[u, "csd_name"]}
                         for u in keep.sort_values("length_km_source", ascending=False)["csd_uid"]]
        if len(dropped):
            print(f"{pid}: kept {len(keep)}, dropped " + ", ".join(
                f"{b.at[u, 'csd_name']} ({k:.1f} km)" for u, k in zip(dropped["csd_uid"], dropped["length_km_source"])))

    path.write_text(header + yaml.safe_dump(reg, allow_unicode=True, sort_keys=False, width=120))
    print(f"-> {path.relative_to(config.ROOT)}")


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 0.1)
