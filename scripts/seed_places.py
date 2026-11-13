"""Seed / update config/places.yaml from a source's files.

Matches each municipality name in the data to the metadata and dictionary files using a
normalised key, and writes the result as an editable registry. Existing entries are kept
(edit them by hand); only new places are added. Names that don't match are listed
under `unmatched` for review.

    python scripts/seed_places.py ccnd_2024
"""

import sys
from pathlib import Path

import pandas as pd
import pyogrio
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline.lib import config  # noqa: E402
from pipeline.lib.text import name_key  # noqa: E402

HEADER = """\
# Place registry. One entry per place (key = place id used across pipeline + web).
# `names` records how each source's files spell the place, so joins are explicit, not inferred.
# Seeded by scripts/seed_places.py; edit freely (display names, accents, CSD lists later).
"""


def slug(name: str) -> str:
    return name_key(pd.Series([name])).iloc[0].replace(" ", "_")


def main(source_id: str) -> None:
    src = config.source(source_id)
    path = config.CONFIG_DIR / "places.yaml"
    reg = yaml.safe_load(path.read_text()) if path.exists() else {}
    places = reg.get("places") or {}

    data = pyogrio.read_dataframe(config.ROOT / src["path"], layer=src.get("layer"),
                                  read_geometry=False, columns=[src["municipality_field"], "province_territory"])
    data = data.drop_duplicates(src["municipality_field"])

    def keys(cfg, col):
        if not cfg:
            return {}
        names = pd.read_csv(config.ROOT / cfg["path"], keep_default_na=False)[col].drop_duplicates()
        return dict(zip(name_key(names), names))

    meta = keys(src.get("metadata"), src.get("metadata", {}).get("key"))
    dic = keys(src.get("dictionary"), src.get("dictionary", {}).get("municipality"))

    matched_meta, matched_dic = set(), set()
    for _, r in data.sort_values(src["municipality_field"]).iterrows():
        name = r[src["municipality_field"]]
        k = name_key(pd.Series([name])).iloc[0]
        pid = next((p for p, v in places.items()
                    if v.get("names", {}).get(source_id, {}).get("data") == name), slug(name))
        entry = places.setdefault(pid, {"name": name, "province": r["province_territory"], "names": {}})
        names = entry["names"].setdefault(source_id, {"data": name})
        if k in meta:
            names.setdefault("metadata", meta[k]); matched_meta.add(k)
        if k in dic:
            names.setdefault("dictionary", dic[k]); matched_dic.add(k)

    unmatched = reg.get("unmatched") or {}
    unmatched[source_id] = {
        "metadata": sorted(v for k, v in meta.items() if k not in matched_meta),
        "dictionary": sorted(v for k, v in dic.items() if k not in matched_dic),
    }
    out = {"places": dict(sorted(places.items())), "unmatched": unmatched}
    path.write_text(HEADER + yaml.safe_dump(out, allow_unicode=True, sort_keys=False, width=120))
    print(f"{len(places)} places -> {path.relative_to(config.ROOT)}; unmatched: {unmatched[source_id]}")


if __name__ == "__main__":
    main(sys.argv[1])
