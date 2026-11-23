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
FIELDS = ["place", "dataset", "type", "class", "source_class", "suggested_class", "note", "by", "link", "examples"]
EXAMPLE_FIELDS = ["lat", "lng", "heading", "segment", "class", "other_class", "status", "source_class"]


def _yaml():
    try:
        import yaml
        return yaml
    except ImportError:  # run from the project venv to save issues
        return None


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
    find = lambda: next(i for i in issues if i["id"] == op["id"])  # noqa: E731
    clean = lambda d, keys: {k: d[k] for k in keys if d.get(k) not in (None, "", [])}  # noqa: E731
    if op["op"] == "add":
        issue = clean(op["issue"], FIELDS)
        if "examples" in issue:
            issue["examples"] = [clean(e, EXAMPLE_FIELDS) for e in issue["examples"]]
        issues.append({"id": secrets.token_hex(4), **issue, "date": date.today().isoformat()})
    elif op["op"] == "add_example":
        ex, new = find().setdefault("examples", []), clean(op["example"], EXAMPLE_FIELDS)
        if new not in ex:  # same spot twice
            ex.append(new)
    elif op["op"] == "delete":
        issues = [i for i in issues if i["id"] != op["id"]]
    elif op["op"] == "delete_example":
        ex = find().get("examples", [])
        del ex[int(op["index"])]
    else:
        raise ValueError(f"unknown op {op['op']}")
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
            op = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
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
