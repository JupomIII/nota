"""What run.bat needs to know about the ports before it starts anything.

run.bat used to start a server unconditionally and then poll the port: with an
instance already running, the poll succeeded because of the *old* process while
the new one died on "address already in use" inside a minimised window nobody
reads. Printing one word makes the three cases explicit in the log:

  free         nothing is listening, start a server
  ready        a NŌTA server answers and serves exactly frontend/dist/index.html
  stale        a NŌTA server answers but cannot serve the current build (it was
               started before the app existed, or before this rebuild)
  foreign:8443 / foreign:8080
               something else owns the port; NŌTA must not fight it

Only loopback is probed, and the TLS certificate is not verified here: this is a
local liveness check, not a trust decision.
"""

from __future__ import annotations

import pathlib
import socket
import ssl
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "frontend" / "dist" / "index.html"
TLS_PORT = 8443
HTTP_PORT = 8080


def listening(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.6)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _get(path: str) -> tuple[int, bytes]:
    request = urllib.request.Request(f"https://127.0.0.1:{TLS_PORT}{path}")
    with urllib.request.urlopen(request, context=_context(), timeout=5) as response:
        return response.status, response.read()


def state() -> str:
    if not listening(TLS_PORT):
        # The laptop's own door matters too: a fresh server would fail to bind it.
        return "foreign:8080" if listening(HTTP_PORT) else "free"
    try:
        status, body = _get("/api/health")
    except Exception:
        return f"foreign:{TLS_PORT}"
    if status != 200 or b"nota-server" not in body:
        return f"foreign:{TLS_PORT}"
    if not INDEX.exists():
        return "stale"
    try:
        status, body = _get("/")
    except Exception:
        return "stale"
    return "ready" if status == 200 and body == INDEX.read_bytes() else "stale"


if __name__ == "__main__":
    print(state())
    sys.exit(0)
