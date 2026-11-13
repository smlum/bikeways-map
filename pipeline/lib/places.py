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
