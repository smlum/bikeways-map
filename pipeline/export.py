"""Final step: copy build outputs + config into web/data/ for the app."""

import json
import shutil

from pipeline.lib import config

WEB_DATA = config.ROOT / "web" / "data"


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
            "label": src["label"], "tiles": tiles.name,
            "summary": summary.name if summary.exists() else None,
        })

    out = {
        **config.load("web"),
        "layer": config.pipeline()["tiles"]["layer"],
        "classes": config.classes(),
        "sources": manifest,
    }
    (WEB_DATA / "config.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"[export] -> web/data/ ({len(manifest)} sources)")
