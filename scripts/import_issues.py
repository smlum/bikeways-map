"""Import approved issue submissions from a CSV into config/issues.yaml.

    python scripts/import_issues.py responses.csv             # file, or a published-sheet CSV URL
    python scripts/import_issues.py responses.csv --dry-run   # print what would be added

The CSV is a form's response sheet (e.g. a Google Form -> Sheet, exported or published as CSV).
Expected columns (header names; extra columns are ignored):
    Timestamp       when it was submitted (used to avoid importing the same row twice)
    City            place name or id (config/places.yaml)
    Issue           Misclassified | Missing infrastructure | Other   (labels from web.yaml issue_types)
    Source class    optional; the city's own category, as in the map key
    Should be       optional; a CAN-BICS class label, "Not cycling infrastructure", or "Not sure"
    What's wrong?   the note
    Dataset         optional; dataset label from sources.yaml (default: CCND 2024)
    Name            optional; shown as "by"
    Link            optional URL
    Approved        review column you add to the sheet: rows marked yes / y / x / TRUE are imported

Entries are appended as text, so comments in issues.yaml survive. Review the diff, edit freely,
then re-run the export: python -m pipeline.run --steps export
"""

import argparse
import csv
import io
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline.lib import config, places  # noqa: E402

ISSUES = config.CONFIG_DIR / "issues.yaml"
EMPTY = {"", "not sure"}
YES = {"yes", "y", "x", "true", "1", "approved"}


def read_csv(src: str) -> list[dict]:
    if re.match(r"https?://", src):
        with urllib.request.urlopen(src) as r:
            text = r.read().decode("utf-8-sig")
    else:
        text = Path(src).read_text(encoding="utf-8-sig")
    # Normalise headers: case/whitespace-insensitive.
    return [{(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
            for row in csv.DictReader(io.StringIO(text))]


def iso_date(ts: str) -> str:
    """Best-effort YYYY-MM-DD from a form timestamp (ISO, or Google's M/D/YYYY H:M:S)."""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%m/%d/%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(ts[:19], fmt).date().isoformat()
        except ValueError:
            pass
    return ts[:10]


def to_entry(row: dict, lookups: dict) -> tuple[dict | None, str]:
    get = lambda k: None if row.get(k, "").lower() in EMPTY else row[k]  # noqa: E731
    city = get("city") or ""
    place = lookups["place"].get(city.lower())
    dataset = lookups["dataset"].get((get("dataset") or "").lower(), "ccnd_2024")
    kind = lookups["type"].get((get("issue") or "").lower())
    should = get("should be")
    suggested = lookups["class"].get(should.lower()) if should else None
    problems = [
        not place and f"unknown city '{city}'",
        not kind and f"unknown issue type '{get('issue')}'",
        should and not suggested and f"unknown class '{should}'",
        not get("what's wrong?") and "no description",
    ]
    if any(problems):
        return None, "; ".join(p for p in problems if p)
    entry = {"place": place}
    if dataset != "ccnd_2024":
        entry["dataset"] = dataset
    if get("source class"):
        entry["source_class"] = get("source class")
    entry["type"] = kind
    if suggested:
        entry["suggested_class"] = suggested
    entry["note"] = get("what's wrong?")
    entry["date"] = iso_date(row.get("timestamp", ""))
    if get("name"):
        entry["by"] = get("name")
    if get("link"):
        entry["link"] = get("link")
    entry["submitted"] = row.get("timestamp", "")
    return entry, ""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", help="path or URL of the responses CSV")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    reg = places.registry()
    lookups = {
        "place": {**{pid: pid for pid in reg}, **{p["name"].lower(): pid for pid, p in reg.items()}},
        "dataset": {s["label"].lower(): sid for sid, s in config.sources().items()},
        "type": {v.lower(): k for k, v in config.load("web")["issue_types"].items()},
        "class": {**{c["label"].lower(): c["slug"] for c in config.classes()["classes"]},
                  "not cycling infrastructure": "exclude"},
    }
    seen = {str(i.get("submitted")) for i in config.load("issues").get("issues") or [] if i.get("submitted")}

    new = []
    for n, row in enumerate(read_csv(args.csv), start=2):  # row 1 = header
        if row.get("approved", "").lower() not in YES or row.get("timestamp", "") in seen:
            continue
        entry, why = to_entry(row, lookups)
        if entry:
            new.append(entry)
        else:
            print(f"skip row {n}: {why} (fix it in the sheet, or add it by hand)")

    if not new:
        print("Nothing new to import.")
        return
    text = yaml.safe_dump(new, sort_keys=False, allow_unicode=True, width=1000)
    text = "".join(f"  {line}\n" for line in text.splitlines())
    if args.dry_run:
        print(text)
        return
    src = re.sub(r"^issues: \[\]\s*$", "issues:", ISSUES.read_text(), flags=re.M)
    ISSUES.write_text(src.rstrip("\n") + "\n" + text)
    print(f"Added {len(new)} issue(s) to {ISSUES.relative_to(config.ROOT)}. Review the diff, then re-run the export.")


if __name__ == "__main__":
    main()
