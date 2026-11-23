"""Place registry (config/places.yaml): explicit name mapping across a source's files."""

from pipeline.lib import config


def registry() -> dict:
    return config.load("places")["places"]


def names(source_id: str, field: str) -> dict:
    """{place_id: name as spelled in `field` ('data' | 'metadata' | 'dictionary')} for one source."""
    return {pid: p["names"][source_id][field] for pid, p in registry().items()
            if field in p.get("names", {}).get(source_id, {})}


def data_name_to_id(source_id: str) -> dict:
    return {v: k for k, v in names(source_id, "data").items()}


def csds() -> dict:
    """{place_id: [csd_uid, ...]} from places.yaml `csds` lists."""
    return {pid: [str(c["uid"]) for c in p.get("csds", [])] for pid, p in registry().items()}


def csd_to_place() -> dict:
    """{csd_uid: place_id}. Each CSD may belong to only one place."""
    out = {}
    for pid, uids in csds().items():
        for u in uids:
            if u in out:
                raise ValueError(f"CSD {u} is listed under both {out[u]} and {pid} in places.yaml")
            out[u] = pid
    return out
