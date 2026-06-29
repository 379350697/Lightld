"""
Small local HTTP sidecar for GMGN token safety.

The Node runtime in some Windows-hosted environments cannot spawn child
processes. This sidecar lets Node call the existing GMGN Python checker over
localhost instead of spawning Python for every batch.
"""

from __future__ import annotations

import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CHECKER_PATH = ROOT / "scripts" / "gmgn-token-safety.py"


def _load_checker():
    spec = importlib.util.spec_from_file_location("gmgn_token_safety", CHECKER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {CHECKER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECKER = _load_checker()


class Handler(BaseHTTPRequestHandler):
    server_version = "LightldGmgnSafety/1.0"

    def _write_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._write_json(200, {"status": "ok"})
            return
        self._write_json(404, {"error": "not-found"})

    def do_POST(self) -> None:
        if self.path not in ("/", "/safety"):
            self._write_json(404, {"error": "not-found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw) if raw else {}
            mints = payload.get("mints")
            if not isinstance(mints, list) or not all(isinstance(mint, str) for mint in mints):
                self._write_json(400, {"error": "mints must be a string array"})
                return

            results = CHECKER.fetch_token_safety_batch(mints)
            self._write_json(200, results)
        except Exception as error:
            self._write_json(500, {"error": str(error)})

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    host = os.environ.get("GMGN_SAFETY_HOST", "127.0.0.1")
    port = int(os.environ.get("GMGN_SAFETY_PORT", "8898"))
    server = HTTPServer((host, port), Handler)
    print(f"gmgn-token-safety-server listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
