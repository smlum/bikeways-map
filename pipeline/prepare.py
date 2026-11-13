"""Step 1: raw source -> clean GeoParquet (2D, EPSG:4326, common columns, stable ids)."""

from pipeline.lib import config, geo, places


def run(source_id: str) -> None:
    src = config.source(source_id)
    scope = config.pipeline().get("scope", {}).get("places") or []
    data_names = places.names(source_id, "data")

    where = None
    if scope:
        missing = [p for p in scope if p not in data_names]
        if missing:
            raise KeyError(f"Scope places not in places.yaml for {source_id}: {missing}")
        quoted = ", ".join("'" + data_names[p].replace("'", "''") + "'" for p in scope)
        where = f"{src['municipality_field']} IN ({quoted})"

    gdf = geo.read(config.ROOT / src["path"], layer=src.get("layer"), where=where)
    print(f"[prepare] {source_id}: read {len(gdf):,} features")

    gdf = geo.rename_columns(gdf, src["columns"])
    gdf["place"] = gdf["municipality"].map(places.data_name_to_id(source_id))
    unmapped = gdf.loc[gdf["place"].isna(), "municipality"].unique()
    if len(unmapped):
        raise KeyError(f"Municipalities missing from places.yaml: {list(unmapped)} "
                       f"(run scripts/seed_places.py {source_id})")
    n = len(gdf)
    gdf = geo.drop_empty(geo.drop_z(gdf))
    if len(gdf) < n:
        print(f"[prepare] dropped {n - len(gdf)} empty geometries")
    gdf["id"] = geo.stable_ids(gdf, prefix=source_id, fields=["source_record_id"])
    gdf = geo.to_wgs84(gdf)
    gdf["length_km"] = geo.geodesic_length_km(gdf)

    dupes = gdf["id"].duplicated().sum()
    if dupes:
        print(f"[prepare] warning: {dupes} duplicate ids (identical record + geometry)")

    cols = ["id", *[c for c in gdf.columns if c not in ("id", "geometry")], "geometry"]
    gdf = gdf[cols]

    out = config.clean_path(source_id)
    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(out)

    by_muni = gdf.groupby("place")[["length_km_source", "length_km"]].sum().round(1)
    print(by_muni.to_string())
    print(f"[prepare] -> {out.relative_to(config.ROOT)}")
