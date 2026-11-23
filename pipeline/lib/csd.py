"""Census subdivision (CSD) boundaries: assign segments to CSDs by their midpoint."""

from functools import lru_cache

import geopandas as gpd
import pandas as pd

from pipeline.lib import config


@lru_cache(maxsize=1)
def boundaries() -> gpd.GeoDataFrame:
    """CSD polygons with columns csd_uid, csd_name, area_km2."""
    c = config.pipeline()["csd_boundaries"]
    gdf = gpd.read_file(config.ROOT / c["path"], engine="pyogrio")
    return gdf.rename(columns={c["id"]: "csd_uid", c["name"]: "csd_name", c["area_km2"]: "area_km2"})[
        ["csd_uid", "csd_name", "area_km2", "geometry"]]


def assign(gdf: gpd.GeoDataFrame) -> pd.Series:
    """CSD uid for each line, from the point halfway along it (None if outside all CSDs)."""
    b = boundaries()
    mid = gpd.GeoDataFrame(geometry=gdf.geometry.interpolate(0.5, normalized=True), crs=gdf.crs).to_crs(b.crs)
    hit = gpd.sjoin(mid, b[["csd_uid", "geometry"]], how="left", predicate="within")
    return hit[~hit.index.duplicated()]["csd_uid"].reindex(gdf.index)
