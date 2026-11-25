"""Match two datasets piece by piece and classify agreement (config/comparisons.yaml).

Segments are cut into ~piece_m pieces, matched one-to-one within tolerance_m (same class first,
then any class; see _match_pair). Each stretch is matched once, so one side of a street recorded in
one dataset but both sides in the other leaves the extra side as "only". Consecutive pieces with the
same result are rejoined into lines, so output geometry follows the original segments. A centreline
does match both sides; where one dataset draws both sides and the other one line, the pieces get
sides = both_a | both_b (see _both_sides). Outputs per pair:
  data/build/tiles/compare_<a>__<b>.pmtiles   layers "a" and "b" (status, class, other_class, sides, plus
                                              the segment fields the map popup shows: web.yaml popup/links)
  data/build/summaries/compare_<a>__<b>.json  per place, per side: km by status x class x other_class;
                                              "sides": street km of matched stretches drawn both sides vs one
"""

import json
import re
import subprocess

import geopandas as gpd
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import shapely
from shapely.ops import substring

from pipeline.lib import config, places

METRIC_CRS = 3347  # Statistics Canada Lambert, metres
ON_LINE_M = 1.5  # closer than this to a line counts as on it (no side)
TIE_M = 0.5      # pieces within this of the closest are treated as equally close (e.g. at junctions)
SIDE_RATIO = 2.0 # far side of the street also matches a line no more than this x nearer the other side
PARALLEL_COS = 0.87  # both-sides check: pieces within ~30° of the other line count as running alongside it


def pair_id(a: str, b: str) -> str:
    return f"compare_{a}__{b}"


BASE_COLS = ["id", "place", "class", "csd_uid", "geometry"]


def _popup_cols(source_id: str) -> list[str]:
    """Segment fields the map popup uses (web.yaml popup keys, link placeholders) that this dataset has,
    carried into the comparison tiles so compare-mode popups can show them."""
    web = config.load("web")
    wanted = [f["key"] for f in web.get("popup", [])]
    for link in web.get("links", []):
        wanted += re.findall(r"\{(\w+)\}", link["url"]) + ([link["requires"]] if link.get("requires") else [])
    have = set(pq.read_schema(config.clean_path(source_id)).names)
    return [c for c in dict.fromkeys(wanted) if c in have and c not in BASE_COLS]


def _load(source_id: str) -> gpd.GeoDataFrame:
    """Clean network limited to each place's profile area, in metres, single-part lines."""
    gdf = gpd.read_parquet(config.clean_path(source_id), columns=BASE_COLS + _popup_cols(source_id))
    area = places.csd_to_place()
    gdf = gdf[gdf["csd_uid"].map(area) == gdf["place"]]
    gdf = gdf.to_crs(METRIC_CRS).explode(index_parts=False).reset_index(drop=True)
    return gdf[gdf.geometry.length > 0]


def _pieces(gdf: gpd.GeoDataFrame, piece_m: float) -> pd.DataFrame:
    """One row per piece: line index, piece index, piece length, midpoint."""
    lengths = gdf.geometry.length.to_numpy()
    n = np.maximum(1, np.ceil(lengths / piece_m)).astype(int)
    line = np.repeat(np.arange(len(gdf)), n)
    k = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
    step = (lengths / n)[line]
    mid = shapely.line_interpolate_point(gdf.geometry.to_numpy()[line], (k + 0.5) * step)
    return pd.DataFrame({"line": line, "k": k, "step": step, "mid": mid})


def _segments(gdf: gpd.GeoDataFrame, pieces: pd.DataFrame) -> np.ndarray:
    """Each piece as a straight 2-point line (start -> end), for matching."""
    g = gdf.geometry.to_numpy()[pieces["line"].to_numpy()]
    k, step = pieces["k"].to_numpy(), pieces["step"].to_numpy()
    p0, p1 = shapely.line_interpolate_point(g, k * step), shapely.line_interpolate_point(g, (k + 1) * step)
    xy = np.stack([shapely.get_coordinates(p0), shapely.get_coordinates(p1)], axis=1)
    return shapely.linestrings(xy)


def _side(geoms: np.ndarray, at: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Which side of each line (at distance `at` along it) each point lies: +1 left, -1 right, 0 on it."""
    L = shapely.length(geoms)
    a = shapely.line_interpolate_point(geoms, np.clip(at - 1, 0, L))
    b = shapely.line_interpolate_point(geoms, np.clip(at + 1, 0, L))
    q = shapely.line_interpolate_point(geoms, at)
    tx, ty = shapely.get_x(b) - shapely.get_x(a), shapely.get_y(b) - shapely.get_y(a)
    vx, vy = shapely.get_x(pts) - shapely.get_x(q), shapely.get_y(pts) - shapely.get_y(q)
    side = np.sign(tx * vy - ty * vx)
    return np.where(np.hypot(vx, vy) < ON_LINE_M, 0, side)


def _one_to_one(own_seg: np.ndarray, own_mid: np.ndarray, other_seg: np.ndarray, tol: float):
    """Match own pieces to other pieces, each stretch once.

    A piece matches the nearest other piece within tol only if, seen from that other piece, the
    piece is the closest own piece on its side. The far side of the street matches too only when
    the other line sits roughly in the middle (far side no more than SIDE_RATIO x as far as the
    near side), i.e. a centreline drawn for both directions. So:
      - one line on one side vs both sides in the other dataset: the far side is left unmatched;
      - a centreline vs both sides (e.g. a divided road): both sides match;
      - a parallel path further away than the matching line: left unmatched.
    Returns (own piece index, other piece index) for matched pieces.
    """
    if not len(own_seg) or not len(other_seg):
        return np.array([], int), np.array([], int)
    pi, li = shapely.STRtree(other_seg).query_nearest(own_mid, max_distance=tol, all_matches=False)
    at = shapely.line_locate_point(other_seg[li], own_mid[pi])
    q = shapely.line_interpolate_point(other_seg[li], at)

    # From q, own pieces within tol, with their distance and side of the other line.
    ci, oi = shapely.STRtree(own_seg).query(q, predicate="dwithin", distance=tol)
    cd = shapely.distance(q[ci], own_seg[oi])
    near = shapely.line_interpolate_point(own_seg[oi], shapely.line_locate_point(own_seg[oi], q[ci]))
    cside = _side(other_seg[li[ci]], at[ci], near)
    c = pd.DataFrame({"q": ci, "side": cside, "d": cd})
    dmin = c.groupby("q")["d"].transform("min").to_numpy()
    side_min = c.groupby(["q", "side"])["d"].transform("min").to_numpy()
    # Side of the closest candidate at each q (0 = an own piece lies on the other line).
    first = c.sort_values(["q", "d"]).drop_duplicates("q")
    near_side = pd.Series(first["side"].to_numpy(), index=first["q"].to_numpy()).reindex(ci).to_numpy()
    keep = (cd <= side_min + TIE_M) & (
        (cside == near_side) | (cside == 0) | ((near_side != 0) & (side_min <= SIDE_RATIO * dmin)))

    is_match = np.zeros(len(pi), bool)
    is_match[ci[keep & (oi == pi[ci])]] = True
    return pi[is_match], li[is_match]


def _match_pair(pa: pd.DataFrame, pb: pd.DataFrame, A: gpd.GeoDataFrame, B: gpd.GeoDataFrame,
                tol: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Add status (agree | differs | only) + other_class to both sides' pieces.

    Pass 1 matches same-class pieces only (so a cycle track drawn on the road centreline in one
    dataset and beside the road in the other still agree). Pass 2 matches what's left, regardless
    of class: those are class conflicts. Anything still unmatched is "only" in its dataset.
    """
    side = {}
    for k, pcs, gdf in (("a", pa, A), ("b", pb, B)):
        side[k] = {"seg": _segments(gdf, pcs), "mid": pcs["mid"].to_numpy(),
                   "cls": gdf["class"].to_numpy()[pcs["line"].to_numpy()],
                   "status": np.full(len(pcs), "only", dtype=object),
                   "other": np.full(len(pcs), None, dtype=object)}
    a, b = side["a"], side["b"]

    pairs = {"a": [], "b": []}  # own side -> [(own piece, other piece)] for every match made

    def run(sel_a, sel_b, status):
        ia, ib = np.flatnonzero(sel_a), np.flatnonzero(sel_b)
        for name, own, other, io, it in (("a", a, b, ia, ib), ("b", b, a, ib, ia)):
            m_own, m_oth = _one_to_one(own["seg"][io], own["mid"][io], other["seg"][it], tol)
            own["status"][io[m_own]] = status
            own["other"][io[m_own]] = other["cls"][it[m_oth]]
            pairs[name].append((io[m_own], it[m_oth]))

    for c in np.unique(np.concatenate([a["cls"], b["cls"]]).astype(str)):
        run(a["cls"] == c, b["cls"] == c, "agree")
    run(a["status"] == "only", b["status"] == "only", "differs")
    for s in (a, b):  # same class matched only in pass 2 (the side rule picked differently): still a match
        s["status"][(s["status"] == "differs") & (s["other"] == s["cls"])] = "agree"

    for s in (a, b):
        s["sides"] = np.full(len(s["status"]), None, dtype=object)
    for name, own, other in (("a", a, b), ("b", b, a)):
        if not pairs[name]:
            continue
        io = np.concatenate([p[0] for p in pairs[name]])
        it = np.concatenate([p[1] for p in pairs[name]])
        flag = f"both_{name}"  # own dataset draws both sides where the other draws one line
        po, pt = _both_sides(own["seg"][io], own["mid"][io], other["seg"][it], io, it)
        own["sides"][po] = flag
        other["sides"][pt] = flag

    return (pa.assign(status=a["status"], other_class=a["other"], sides=a["sides"]),
            pb.assign(status=b["status"], other_class=b["other"], sides=b["sides"]))


def _both_sides(own_seg, own_mid, other_seg, io, it):
    """Matches where two own pieces, roughly parallel, on opposite sides, matched the same other
    piece: one dataset draws a line each side of the street, the other one line (e.g. a pair of
    one-way cycle tracks vs one line). Returns (own pieces, other pieces) involved.
    The geometry can't tell a single line for a two-way facility from one for a pair, so this is
    reported as a drawing difference, not as anything missing."""
    at = shapely.line_locate_point(other_seg, own_mid)
    side = _side(other_seg, at, own_mid)
    d_own, d_oth = (shapely.get_coordinates(s).reshape(-1, 2, 2) for s in (own_seg, other_seg))
    v_own, v_oth = (d[:, 1] - d[:, 0] for d in (d_own, d_oth))
    cos = np.abs((v_own * v_oth).sum(1)) / (np.hypot(*v_own.T) * np.hypot(*v_oth.T) + 1e-9)
    df = pd.DataFrame({"own": io, "other": it, "side": side})[(side != 0) & (cos >= PARALLEL_COS)]
    n_sides = df.groupby("other")["side"].transform("nunique")
    hit = df[n_sides == 2]
    return hit["own"].unique(), hit["other"].unique()


def _runs(pieces: pd.DataFrame, own: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Rejoin consecutive pieces of a line with the same status/other_class into one line."""
    key = pieces["status"] + "|" + pieces["other_class"].fillna("") + "|" + pieces["sides"].fillna("")
    new_run = (pieces["line"] != pieces["line"].shift()) | (key != key.shift())
    pieces = pieces.assign(run=new_run.cumsum())
    runs = pieces.groupby("run").agg(line=("line", "first"), k0=("k", "min"), k1=("k", "max"),
                                     step=("step", "first"), status=("status", "first"),
                                     other_class=("other_class", "first"), sides=("sides", "first"))
    geoms = own.geometry.to_numpy()
    runs["geometry"] = [substring(geoms[l], a * s, (b + 1) * s)
                        for l, a, b, s in zip(runs["line"], runs["k0"], runs["k1"], runs["step"])]
    keep = [c for c in own.columns if c not in ("csd_uid", "geometry")]
    attrs = own[keep].iloc[runs["line"].to_numpy()].reset_index(drop=True)
    out = gpd.GeoDataFrame(pd.concat([attrs, runs.reset_index(drop=True)[["status", "other_class", "sides", "geometry"]]], axis=1),
                           geometry="geometry", crs=own.crs)
    out["length_km"] = out.geometry.length / 1000
    return out


def _stats(side: pd.DataFrame) -> dict:
    """{place: [[status, class, other_class, km], ...]}: km by match result and class pair, so the
    app can group / filter rows (e.g. by comfort level) without re-running the comparison."""
    s = (side.assign(other_class=side["other_class"].fillna(""))
         .groupby(["place", "status", "class", "other_class"])["length_km"].sum().round(2))
    return {p: [[st, c, o or None, km] for (st, c, o), km in g.droplevel(0).items() if km > 0]
            for p, g in s.groupby(level=0)}


def _sides_stats(sa: pd.DataFrame, sb: pd.DataFrame) -> dict:
    """{place: [[sides, class, km], ...]} for matched stretches (same class) drawn as both sides in one
    dataset and one line in the other. km is the one-line dataset's length, i.e. street length."""
    single = pd.concat([sa[sa["sides"] == "both_b"], sb[sb["sides"] == "both_a"]])
    single = single[single["status"] == "agree"]
    s = single.groupby(["place", "sides", "class"])["length_km"].sum().round(2)
    return {p: [[sd, c, km] for (sd, c), km in g.droplevel(0).items() if km > 0]
            for p, g in s.groupby(level=0)}


def run_pair(a: str, b: str, piece_m: float, tolerance_m: float) -> None:
    pid = pair_id(a, b)
    A, B = _load(a), _load(b)
    print(f"[compare] {pid}: {len(A):,} vs {len(B):,} lines")
    matched = dict(zip("ab", _match_pair(_pieces(A, piece_m), _pieces(B, piece_m), A, B, tolerance_m)))
    sides = {}
    for name, own in (("a", A), ("b", B)):
        pieces = matched[name]
        sides[name] = _runs(pieces, own)
        print(f"[compare]   {name}: {len(pieces):,} pieces -> {len(sides[name]):,} runs; "
              + ", ".join(f"{k} {v:,.0f} km" for k, v in sides[name].groupby("status")["length_km"].sum().items()))

    summary = {"id": pid, "a": a, "b": b, "piece_m": piece_m, "tolerance_m": tolerance_m, "places": {}}
    sa, sb = _stats(sides["a"]), _stats(sides["b"])
    both = _sides_stats(sides["a"], sides["b"])
    for p in sorted(set(sa) | set(sb)):
        summary["places"][p] = {"a": sa.get(p, []), "b": sb.get(p, []), "sides": both.get(p, [])}
    path = config.build_dir() / "summaries" / f"{pid}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=False))

    tiles_dir = config.build_dir() / "tiles"
    layers = []
    for name, gdf in sides.items():
        f = tiles_dir / f"{pid}_{name}.geojsonl"
        g = gdf.to_crs(4326)
        g["length_km"] = g["length_km"].round(3)
        g.to_file(f, driver="GeoJSONSeq", engine="pyogrio")
        layers += ["-L", f"{name}:{f}"]
    out = tiles_dir / f"{pid}.pmtiles"
    args = [a for a in config.pipeline()["tiles"]["args"]]
    subprocess.run(["tippecanoe", "-o", str(out), *args, *layers], check=True)
    for name in sides:
        (tiles_dir / f"{pid}_{name}.geojsonl").unlink()
    print(f"[compare] -> {out.relative_to(config.ROOT)} ({out.stat().st_size / 1e6:.1f} MB), {path.relative_to(config.ROOT)}")


def run() -> None:
    cfg = config.load("comparisons")
    for pair in cfg.get("pairs", []):
        p = {**cfg.get("defaults", {}), **pair}
        run_pair(p["a"], p["b"], p["piece_m"], p["tolerance_m"])
