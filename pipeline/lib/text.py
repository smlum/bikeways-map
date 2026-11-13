"""Text normalisation for joining across files with inconsistent naming."""

import re

import pandas as pd


def name_key(s: pd.Series) -> pd.Series:
    """Join key for place / class names: 'St. John's' == 'st_johns', 'bike lane ' == 'bike lane'."""
    return (s.astype(str).str.casefold().str.replace("_", " ")
            .str.replace(r"[.'’,]", "", regex=True).str.replace(r"\s+", " ", regex=True).str.strip())


def name_key_str(v: str) -> str:
    return name_key(pd.Series([v])).iloc[0]
