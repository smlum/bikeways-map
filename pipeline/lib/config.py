"""Load YAML config from config/."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"


def load(name: str) -> dict:
    with open(CONFIG_DIR / f"{name}.yaml") as f:
        return yaml.safe_load(f)


def pipeline() -> dict:
    return load("pipeline")


def sources() -> dict:
    """Source entries; keys starting with '.' are YAML anchors for shared settings, not sources."""
    return {k: v for k, v in load("sources").items() if not k.startswith(".")}


def source(source_id: str) -> dict:
    srcs = sources()
    if source_id not in srcs:
        raise KeyError(f"Unknown source '{source_id}'. Known: {list(srcs)}")
    return {"id": source_id, **srcs[source_id]}


def classes() -> dict:
    return load("classes")


def build_dir() -> Path:
    return ROOT / pipeline()["build_dir"]


def clean_path(source_id: str) -> Path:
    return build_dir() / "clean" / f"{source_id}.parquet"
