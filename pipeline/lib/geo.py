"""Reusable geometry / dataframe helpers. Dataset-agnostic."""

import hashlib

import geopandas as gpd
import shapely
from pyproj import Geod

GEOD = Geod(ellps="WGS84")


def read(path, layer=None, where=None) -> gpd.GeoDataFrame:
    return gpd.read_file(path, layer=layer, where=where, engine="pyogrio")


def filter_values(gdf, field, values):
    """Keep rows where `field` is in `values`. No-op if values is empty."""
    if not values:
        return gdf
    return gdf[gdf[field].isin(values)]


def rename_columns(gdf, mapping: dict) -> gpd.GeoDataFrame:
    """Keep and rename columns per {source: common}; keep geometry."""
    missing = set(mapping) - set(gdf.columns)
    if missing:
        raise KeyError(f"Columns not in source: {sorted(missing)}")
    return gdf[[*mapping, gdf.geometry.name]].rename(columns=mapping)


def drop_z(gdf) -> gpd.GeoDataFrame:
    gdf = gdf.copy()
    gdf.geometry = shapely.force_2d(gdf.geometry.values)
    return gdf


def drop_empty(gdf) -> gpd.GeoDataFrame:
    return gdf[~(gdf.geometry.is_empty | gdf.geometry.isna())]


def to_wgs84(gdf) -> gpd.GeoDataFrame:
    return gdf.to_crs(4326)


def geodesic_length_km(gdf) -> "pd.Series":
    """Ellipsoidal length in km. Expects EPSG:4326."""
    assert gdf.crs.to_epsg() == 4326, "geodesic_length_km expects EPSG:4326"
    return gdf.geometry.apply(GEOD.geometry_length) / 1000


def stable_ids(gdf, prefix: str, fields: list[str]) -> "pd.Series":
    """Deterministic id from selected fields + geometry. Same input -> same id."""
    def _hash(row, geom):
        h = hashlib.sha1()
        for f in fields:
            h.update(str(row[f]).encode())
        h.update(shapely.to_wkb(geom))
        return f"{prefix}-{h.hexdigest()[:12]}"

    return [_hash(row, geom) for (_, row), geom in zip(gdf.iterrows(), gdf.geometry)]
