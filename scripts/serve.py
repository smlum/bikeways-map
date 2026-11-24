"""Local dev server with HTTP Range support (needed for PMTiles), plus a small issues API.

    python scripts/serve.py [port]   # serves web/ at http://localhost:8000

Issues API (local use only; the map uses it when present, else the issues baked into config.json):
    GET  /api/issues                                   -> {"issues": [...]}
    POST /api/issues {"op": "add", "issue": {...}}     -> new issue (id and date filled in)
                     {"op": "add_example", "id", "example": {...}}
                     {"op": "delete", "id"}
                     {"op": "delete_example", "id", "index"}
Saves straight to config/issues.yaml (header comments kept). Re-run the export to bake them in.
"""

import json
import os
import re
import secrets
import sys
import threading
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
ISSUES = ROOT / "config" / "issues.yaml"
_lock = threading.Lock()


def _yaml():
    try:
        import yaml
        return yaml
    except ImportError:  # run from the project venv to save issues
        return None


# --- validation -----------------------------------------------------------------------------
# Every write is checked here; anything unexpected is rejected (400), not cleaned up. Keep the
# deployed issues function's rules identical to these.
NOTE_MAX, BY_MAX, SOURCE_CLASS_MAX = 200, 40, 120
EXAMPLES_MAX, ISSUES_MAX, BODY_MAX = 20, 1000, 20_000
TEXT_PUNCT = set(" ,./?!'’-():;")  # plus letters (accented too) and digits
STATUSES = {"agree", "differs", "only"}


def _allowed() -> dict:
    """Valid places, datasets, types and classes, from the exported app config + places.yaml."""
    cfg = json.loads((WEB / "data" / "config.json").read_text())
    places = _yaml().safe_load((ROOT / "config" / "places.yaml").read_text())["places"]
    slugs = {c["slug"] for c in cfg["classes"]["classes"]}
    return {"place": set(places), "dataset": {s["id"] for s in cfg["sources"]},
            "type": set(cfg.get("issue_types", {})), "class": slugs, "suggested_class": slugs | {"exclude"},
            "bounds": cfg.get("max_bounds") or [[-180, -90], [180, 90]]}


def _text(v, field: str, limit: int) -> str:
    """Plain text: letters, digits, spaces and a little punctuation; single line; <= limit chars."""
    if not isinstance(v, str):
        raise ValueError(f"{field} must be text")
    v = " ".join(v.split())
    if len(v) > limit:
        raise ValueError(f"{field} is longer than {limit} characters")
    bad = {ch for ch in v if not (ch.isalnum() or ch in TEXT_PUNCT)}
    if bad:
        raise ValueError(f"{field} has characters that aren't allowed: {' '.join(sorted(bad))}")
    return v


def _source_class(v, field: str = "source_class") -> str:
    """A city's own category, as spelled in the data: any printable text except < > and quotes."""
    if not isinstance(v, str) or len(v) > SOURCE_CLASS_MAX or any(ch in '<>"`' or not ch.isprintable() for ch in v):
        raise ValueError(f"{field} isn't a valid source class")
    return v


def _num(v, field: str, lo: float, hi: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise ValueError(f"{field} must be a number between {lo} and {hi}")
    return v


def _one_of(v, field: str, allowed: set) -> str:
    if v not in allowed:
        raise ValueError(f"unknown {field}: {str(v)[:40]}")
    return v


def check_example(e, a: dict) -> dict:
    if not isinstance(e, dict):
        raise ValueError("example must be an object")
    (w, s), (east, n) = a["bounds"]
    out = {"lat": _num(e.get("lat"), "lat", s, n), "lng": _num(e.get("lng"), "lng", w, east)}
    if e.get("heading") is not None:
        out["heading"] = _num(e["heading"], "heading", -360, 360)
    if e.get("segment"):
        if not isinstance(e["segment"], str) or not re.fullmatch(r"[\w.-]{1,64}", e["segment"]):
            raise ValueError("segment isn't a valid id")
        out["segment"] = e["segment"]
    for k in ("class", "other_class"):
        if e.get(k):
            out[k] = _one_of(e[k], k, a["class"])
    if e.get("status"):
        out["status"] = _one_of(e["status"], "status", STATUSES)
    if e.get("source_class"):
        out["source_class"] = _source_class(e["source_class"])
    return out


def check_issue(i, a: dict) -> dict:
    if not isinstance(i, dict):
        raise ValueError("issue must be an object")
    out = {"place": _one_of(i.get("place"), "place", a["place"]),
           "dataset": _one_of(i.get("dataset"), "dataset", a["dataset"]),
           "type": _one_of(i.get("type"), "type", a["type"])}
    for k in ("class", "suggested_class"):
        if i.get(k):
            out[k] = _one_of(i[k], k, a[k])
    if i.get("source_class"):
        out["source_class"] = _source_class(i["source_class"])
    if i.get("note"):
        out["note"] = _text(i["note"], "note", NOTE_MAX)
    if i.get("by"):
        out["by"] = _text(i["by"], "by", BY_MAX)
    if i.get("by_id"):  # random per-browser id (web app), for finding / undoing one browser's issues
        out["by_id"] = _id(i["by_id"])
    ex = i.get("examples") or []
    if not isinstance(ex, list) or len(ex) > EXAMPLES_MAX:
        raise ValueError(f"at most {EXAMPLES_MAX} examples")
    if ex:
        out["examples"] = [check_example(e, a) for e in ex]
    return out


def _id(v) -> str:
    if not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{1,16}", v):
        raise ValueError("invalid id")
    return v


def read_issues() -> list[dict]:
    yaml = _yaml()
    data = yaml.safe_load(ISSUES.read_text()) if ISSUES.exists() else None
    issues = (data or {}).get("issues") or []
    for i in issues:  # hand-written entries get an id on first save
        i.setdefault("id", secrets.token_hex(4))
        if "date" in i:
            i["date"] = str(i["date"])
    return issues


def write_issues(issues: list[dict]) -> None:
    """Rewrite the issues list, keeping the file's leading comment block."""
    yaml = _yaml()
    text = ISSUES.read_text() if ISSUES.exists() else ""
    header = "".join(l for l in text.splitlines(keepends=True)[:_header_len(text)])
    body = yaml.safe_dump({"issues": issues}, sort_keys=False, allow_unicode=True, width=1000)
    ISSUES.write_text(header + body)


def _header_len(text: str) -> int:
    lines = text.splitlines()
    n = 0
    while n < len(lines) and (lines[n].startswith("#") or not lines[n].strip()):
        n += 1
    return n


def apply(op: dict) -> list[dict]:
    issues = read_issues()
    if not isinstance(op, dict):
        raise ValueError("expected an object")
    a = _allowed()
    find = lambda: next(i for i in issues if i["id"] == _id(op.get("id")))  # noqa: E731
    if op.get("op") == "add":
        if len(issues) >= ISSUES_MAX:
            raise ValueError(f"issue limit ({ISSUES_MAX}) reached")
        issues.append({"id": secrets.token_hex(4), **check_issue(op.get("issue"), a), "date": date.today().isoformat()})
    elif op.get("op") == "add_example":
        ex, new = find().setdefault("examples", []), check_example(op.get("example"), a)
        if len(ex) >= EXAMPLES_MAX:
            raise ValueError(f"at most {EXAMPLES_MAX} examples")
        if new not in ex:  # same spot twice
            ex.append(new)
    elif op.get("op") == "delete":
        issues = [i for i in issues if i["id"] != _id(op.get("id"))]
    elif op.get("op") == "delete_example":
        ex = find().get("examples", [])
        n = op.get("index")
        if isinstance(n, bool) or not isinstance(n, int) or not 0 <= n < len(ex):
            raise ValueError("invalid example index")
        del ex[n]
    else:
        raise ValueError(f"unknown op {str(op.get('op'))[:20]}")
    write_issues(issues)
    return issues


class RangeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] != "/api/issues":
            return super().do_GET()
        if not _yaml():
            return self._json(501, {"error": "run the server from the project venv to use issues"})
        with _lock:
            self._json(200, {"issues": read_issues()})

    def do_POST(self):
        if self.path != "/api/issues" or not _yaml():
            return self._json(404 if self.path != "/api/issues" else 501, {"error": "not available"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > BODY_MAX:
                raise ValueError("request too large")
            op = json.loads(self.rfile.read(n))
            with _lock:
                self._json(200, {"issues": apply(op)})
        except (ValueError, KeyError, StopIteration, IndexError) as e:
            self._json(400, {"error": str(e)})

    def send_head(self):
        m = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start, end = int(m[1]), int(m[2]) if m[2] else size - 1
        end = min(end, size - 1)
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        n = getattr(self, "_remaining", None)
        if n is None:
            return super().copyfile(source, outputfile)
        outputfile.write(source.read(n))
        self._remaining = None


if __name__ == "__main__":
    # Saving issues needs PyYAML: if this Python lacks it, re-run with the project venv's.
    venv_py = ROOT / ".venv" / "bin" / "python"
    if not _yaml() and venv_py.exists() and Path(sys.prefix).resolve() != (ROOT / ".venv").resolve():
        os.execv(str(venv_py), [str(venv_py), __file__, *sys.argv[1:]])
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"http://localhost:{port}" + ("" if _yaml() else "  (issues read-only: run from the project venv to save)"))
    # Localhost only: the issues API writes to config/.
    ThreadingHTTPServer(("127.0.0.1", port), RangeHandler).serve_forever()
