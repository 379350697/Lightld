"""
Small local HTTP sidecar for GMGN token safety.

The Node runtime in some Windows-hosted environments cannot spawn child
processes. This sidecar lets Node call the existing GMGN Python checker over
localhost instead of spawning Python for every batch.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CHECKER_PATH = ROOT / "scripts" / "gmgn-token-safety.py"
LOG_PATH = Path(os.environ.get("GMGN_SAFETY_LOG_PATH", ROOT / "logs" / "gmgn-safety.log"))


def _log(message: str) -> None:
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = f"[{timestamp}] {message}"
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def _run_checker(mints: list[str]) -> list[dict[str, Any]]:
    python_bin = os.environ.get("GMGN_CHECKER_PYTHON_BIN") or sys.executable
    timeout_sec = float(os.environ.get("GMGN_SAFETY_SUBPROCESS_TIMEOUT_SEC", "90"))
    creationflags = 0
    startupinfo = None
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

    started_at = time.monotonic()
    mint_preview = ",".join(mints[:3])
    if len(mints) > 3:
        mint_preview += ",..."
    _log(f"checker starting count={len(mints)} mints={mint_preview}")

    stdout_temp = tempfile.NamedTemporaryFile(prefix="lightld-gmgn-stdout-", suffix=".json", delete=False)
    stderr_temp = tempfile.NamedTemporaryFile(prefix="lightld-gmgn-stderr-", suffix=".log", delete=False)
    stdout_temp.close()
    stderr_temp.close()
    stdout_path = Path(stdout_temp.name)
    stderr_path = Path(stderr_temp.name)
    try:
        with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
            completed = subprocess.run(
                [python_bin, str(CHECKER_PATH), "--stdin"],
                input=json.dumps(mints),
                stdout=stdout_file,
                stderr=stderr_file,
                check=False,
                creationflags=creationflags,
                encoding="utf-8",
                startupinfo=startupinfo,
                timeout=timeout_sec,
            )
    except subprocess.TimeoutExpired as error:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        _log(f"checker timeout elapsedMs={elapsed_ms} timeoutSec={timeout_sec} mints={mint_preview}")
        raise RuntimeError(f"checker timed out after {timeout_sec}s") from error

    stdout = _read_text(stdout_path)
    stderr = _read_text(stderr_path)
    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    stderr_preview = stderr.strip().replace("\n", " ")[:500]
    _log(
        f"checker exited code={completed.returncode} elapsedMs={elapsed_ms} "
        f"stdoutBytes={len(stdout.encode('utf-8'))} stderrBytes={len(stderr.encode('utf-8'))} "
        f"stderr={stderr_preview}"
    )

    try:
        stdout_path.unlink(missing_ok=True)
        stderr_path.unlink(missing_ok=True)
    except Exception:
        pass

    if completed.returncode != 0:
        detail = stderr.strip() or stdout.strip() or f"checker exited with code {completed.returncode}"
        raise RuntimeError(detail)

    try:
        payload = json.loads(stdout or "[]")
    except json.JSONDecodeError as error:
        raise RuntimeError(f"checker returned invalid JSON: {error}") from error

    if not isinstance(payload, list):
        raise RuntimeError("checker returned non-list JSON")

    return payload


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

            results = _run_checker(mints)
            self._write_json(200, results)
        except Exception as error:
            _log(f"request failed error={error}")
            self._write_json(500, {"error": str(error)})

    def log_message(self, format: str, *args: Any) -> None:
        return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    host = os.environ.get("GMGN_SAFETY_HOST", "127.0.0.1")
    port = int(os.environ.get("GMGN_SAFETY_PORT", "8898"))
    server = Server((host, port), Handler)
    _log(f"gmgn-token-safety-server listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
