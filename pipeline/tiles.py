"""Step 2: clean GeoParquet -> PMTiles via tippecanoe."""

import subprocess

import geopandas as gpd

from pipeline.lib import config


def run(source_id: str) -> None:
    settings = config.pipeline()["tiles"]
    gdf = gpd.read_parquet(config.clean_path(source_id))

    out_dir = config.build_dir() / "tiles"
    out_dir.mkdir(parents=True, exist_ok=True)
    seq = out_dir / f"{source_id}.geojsonl"
    out = out_dir / f"{source_id}.pmtiles"

    gdf["length_km"] = gdf["length_km"].round(3)
    gdf.to_file(seq, driver="GeoJSONSeq", engine="pyogrio")

    cmd = ["tippecanoe", "-o", str(out), "-l", settings["layer"], *settings["args"], str(seq)]
    print(f"[tiles] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    seq.unlink()
    print(f"[tiles] -> {out.relative_to(config.ROOT)} ({out.stat().st_size / 1e6:.1f} MB)")
