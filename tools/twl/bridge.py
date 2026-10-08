"""Lokální bridge: jeden stdlib HTTP server servíruje `docs/` (statický dashboard)
i `/api/*` (orchestrace Python nástrojů) na stejné origin, takže není potřeba CORS
ani mixed-content výjimky. Žádný text neopouští počítač, pokud není explicitně
nakonfigurovaný vzdálený LLM backend.

    python3 tools/twl/bridge.py            # http://127.0.0.1:8777/
    python3 tools/twl/bridge.py 8080       # jiný port
"""
from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twl import __version__, orchestrator, paths  # noqa: E402
from twl.adapters import capabilities  # noqa: E402

MAX_BODY = 2_000_000


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(paths.DOCS), **kw)

    def log_message(self, fmt, *args):  # tišší log
        if self.path.startswith("/api/"):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _json(self, status: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            return self._json(200, {"ok": True, "service": "text-watermark-lab bridge", "version": __version__})
        if self.path == "/api/capabilities":
            return self._json(200, {"ok": True, "tools": capabilities(), "version": __version__})
        if self.path.startswith("/api/"):
            return self._json(404, {"ok": False, "error": "unknown endpoint"})
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith("/api/"):
            return self._json(404, {"ok": False, "error": "unknown endpoint"})
        n = int(self.headers.get("Content-Length", "0"))
        if n > MAX_BODY:
            return self._json(413, {"ok": False, "error": "body too large"})
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return self._json(400, {"ok": False, "error": "invalid JSON"})
        text = req.get("text", "")
        if not isinstance(text, str):
            return self._json(400, {"ok": False, "error": "text must be a string"})
        options = req.get("options") or {}
        try:
            if self.path == "/api/run":
                rep = orchestrator.run_one(text, req.get("mode", "analyze"), req.get("tool"), options)
                return self._json(200, {"ok": True, "report": rep})
            if self.path == "/api/compare":
                rep = orchestrator.compare(text, options, include_statistical=bool(req.get("statistical", True)))
                return self._json(200, {"ok": True, "report": rep})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
        return self._json(404, {"ok": False, "error": "unknown endpoint"})


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"text-watermark-lab bridge: http://{host}:{port}/  (dashboard + /api, Ctrl+C ukončí)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nKonec.")


if __name__ == "__main__":
    main()
