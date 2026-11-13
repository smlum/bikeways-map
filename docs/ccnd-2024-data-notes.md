# CCND 2024: data notes

Audit of `cycle_network_2024.gpkg` + companion CSVs (national, 82,115 rows, ~18,700 km).

## Quirks and how the pipeline handles them

| Issue | Detail | Handling |
|---|---|---|
| Z coordinates | `MultiLineString Z`; ~90% of Z values are NaN, real values only in a few cities (mostly Ottawa) | Dropped (`force_2d`) |
| Projection | EPSG:3347 (Lambert); planar lengths are ~1.5% longer than real (geodesic) length | Reproject to 4326; recompute geodesic km for reference only |
| `length_km` | Matches geodesic length (median ratio 0.9998); 1 null | Used as headline km |
| Empty geometry | 1 row (Oakville, source class `2`, null length) | Dropped |
| Multipart lines | 1,421 rows, up to 41 parts (Sherbrooke, Edmonton, Saguenay …) | Kept as-is |
| Very short segments | 1,931 under 5 m | Kept as-is |
| `record_id` not unique | 2 ids shared by different segments (Chilliwack, York Region) | Own stable id: hash of record_id + geometry |
| Column names | GeoPackage uses `snake_case`; `column_descriptions.csv` documents `nocase` names | Column map in `config/sources.yaml` |
| Municipality names | Title case in the gpkg (`St John's`), snake_case in the CSVs (`st_johns`); Saint John, NB is spelled `St John` | Explicit mapping in `config/places.yaml` (seeded by `scripts/seed_places.py`) |
| Source rows without matching data | `kitchener_mup` in sources/dictionary; Markham and Newmarket in the dictionary only (data under York Region) | Ignored |
| Placeholder source classes | Literal `none` as a source class (Kitchener 77 km, Squamish 40, Orangeville 14, Regina 1); `nan`/`none` in the dictionary | Shown as-is |
| Numeric source classes | Codes with no lookup: Lévis, Oakville, Prince George, Rimouski, Rouyn-Noranda, Saguenay | Shown as-is (needs a code table) |
| Trailing whitespace | `bike lane `, `protected bike lane `. In York Region, `protected bike lane` (16.4 km) → painted_bike_lane but `protected bike lane ` (0.4 km) → cycle_track | Normalised for joins only; profile flags "split by spelling variant" |
| One source class → several CAN-BICS classes | Vancouver `protected bike lanes` → cycle_track / bike_path / multi_use_path, decided by `source_class_secondary`; the dictionary lists only cycle_track (76 km disagree). The only case nationally: source + secondary class removes all ambiguity | Profile shows secondary classes and flags "split by secondary class" |
| Secondary class as descriptor | e.g. Montréal: separation type (`Road marking`, `Bollard` …); 22 km of `piste cyclable sur rue` with only `Road marking` → cycle_track | Shown in profile |
| Source classes missing from the dictionary | 64 municipality/class pairs (e.g. Campbell River, Maple Ridge, North Vancouver) | No example link |
| Sparse attributes | `surface_type` 25%, `width_m` 6% (1,321 widths are `0`), `source_class_secondary` 6%, `source_data_id` null for 20 municipalities | Shown as "not recorded" where configured |
| Messy provenance | `download_url` = `Manual` (16), trailing spaces in URLs, mixed licence URL formats | Shown as-is |
| `csdname` null | 3 rows (Surrey, Oakville, 1.8 km) | n/a |

## Suggestions for future releases

1. **Fix the geometry:** 2D LineStrings, no NaN Z, and also publish in EPSG:4326 (GeoParquet/FlatGeobuf alongside GeoPackage).
2. **Stable, unique IDs:** a persistent `segment_id` across vintages, so segments can be compared over time and issues reported against a fixed id.
3. **One naming convention** for municipality keys across all files; document the gpkg's actual column names.
4. **A complete dictionary:** document when `source_class_secondary` is used in the assignment; every source class in the data, including code tables for numeric classes and what the placeholders (`none`, `nan`, `inconnu`) mean.
5. **One mapping per municipality and source class.** Where a source class is split across several CAN-BICS classes, publish the rule used (attribute or manual edit).
6. **Mark the excluded network:** release `not_classified` segments, or their km, so readers can see what was left out.
7. **Explicit nulls:** no sentinel values (`0` width, `unknown`, `Manual`); trimmed strings.
8. **Per-row provenance:** source dataset id and source vintage on every row, not only per municipality.
9. **Changelog and versioning** between vintages (method changes, reclassifications), plus a channel for errata and known issues.
