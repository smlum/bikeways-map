"""Step 1: raw source -> clean GeoParquet (2D, EPSG:4326, common columns, place, csd, stable ids)."""

from pipeline.lib import config, csd, geo, places


def _where(src: dict, source_id: str, scope: list[str]) -> str | None:
    """SQL filter applied while reading, so out-of-scope rows are never loaded."""
    if src["place_by"] == "municipality":
        if not scope:
            return None
        names = places.names(source_id, "data")
        missing = [p for p in scope if p not in names]
        if missing:
            raise KeyError(f"Scope places not in places.yaml for {source_id}: {missing}")
        quoted = ", ".join("'" + names[p].replace("'", "''") + "'" for p in scope)
        return f"{src['municipality_field']} IN ({quoted})"
    # place_by csd: keep only CSDs that belong to a (scoped) place, unless the source keeps
    # everything (keep_outside_places); rows outside any place then get no place.
    if src.get("keep_outside_places") and not scope:
        return None
    uid_col = next(k for k, v in src["columns"].items() if v == "csd_uid")
    uids = [u for p, us in places.csds().items() if not scope or p in scope for u in us]
    if not uids:
        raise KeyError(f"No CSDs in places.yaml; run scripts/seed_place_csds.py first")
    return f"{uid_col} IN ({', '.join(repr(u) for u in uids)})"


def run(source_id: str) -> None:
    src = config.source(source_id)
    scope = config.pipeline().get("scope", {}).get("places") or []

    gdf = geo.read(config.ROOT / src["path"], layer=src.get("layer"), where=_where(src, source_id, scope))
    print(f"[prepare] {source_id}: read {len(gdf):,} features")

    gdf = geo.rename_columns(gdf, src["columns"])
    for c in src.get("int_columns", []):
        gdf[c] = gdf[c].astype("Int64").astype(str)
    if "class_map" in src:
        gdf["class"] = gdf["source_class"].map(src["class_map"])
        unmapped = gdf.loc[gdf["class"].isna(), "source_class"].unique()
        if len(unmapped):
            print(f"[prepare] warning: source classes not in class_map: {list(unmapped)}")
            gdf["class"] = gdf["class"].fillna("unknown")

    n = len(gdf)
    gdf = geo.drop_empty(geo.drop_z(gdf))
    if len(gdf) < n:
        print(f"[prepare] dropped {n - len(gdf)} empty geometries")

    if src.get("csd") == "spatial":
        gdf["csd_uid"] = csd.assign(gdf)

    if src["place_by"] == "municipality":
        gdf["place"] = gdf["municipality"].map(places.data_name_to_id(source_id))
        unmapped = gdf.loc[gdf["place"].isna(), "municipality"].unique()
        if len(unmapped):
            raise KeyError(f"Municipalities missing from places.yaml: {list(unmapped)} "
                           f"(run scripts/seed_places.py {source_id})")
    else:
        gdf["place"] = gdf["csd_uid"].map(places.csd_to_place())

    gdf["id"] = geo.stable_ids(gdf, prefix=source_id, fields=src.get("id_fields", []))
    gdf = geo.to_wgs84(gdf)
    gdf["length_km"] = geo.geodesic_length_km(gdf)
    if "length_km_source" not in gdf.columns:
        gdf["length_km_source"] = gdf["length_km"]

    dupes = gdf["id"].duplicated().sum()
    if dupes:
        print(f"[prepare] warning: {dupes} duplicate ids (identical record + geometry)")

    cols = ["id", *[c for c in gdf.columns if c not in ("id", "geometry")], "geometry"]
    gdf = gdf[cols]

    out = config.clean_path(source_id)
    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(out)

    totals = gdf.groupby("place")[["length_km_source", "length_km"]].sum()
    print(f"[prepare] {len(totals)} places, {totals['length_km_source'].sum():,.0f} km")
    print(f"[prepare] -> {out.relative_to(config.ROOT)}")
