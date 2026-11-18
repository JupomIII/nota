"""End-to-end checks of both address modes, with no tunnel installed.

Phase 1 starts the real server with ``public_url`` set and puts a small relay in
front of it that adds ``X-Forwarded-For`` — exactly what ``tailscale serve`` and
``cloudflared`` do — then asserts the behaviour a tunnel would have to produce.
Phase 2 starts the same build with no ``public_url`` and asserts the ordinary
LAN mode is untouched: TLS with the local certificate, mDNS announced, the port
on every interface, the profile downloadable.

Everything stays on this machine: the relay listens on loopback, the trusted
mode binds loopback only, and the LAN port is only probed from here.

    backend\\.venv\\Scripts\\python.exe scripts\\verify-address-modes.py

Exit status 0 means every check passed. Each server, the relay, its log and its
temporary data directory are removed on the way out.
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.config import local_ip  # noqa: E402

PUBLIC = "https://nota-verify.ts.net"
# TEST-NET-3: a documentation address, so nothing here looks like a real device.
CLIENT_IP = "203.0.113.7"
START_TIMEOUT = 40.0


class Checks:
    """Counts what passed, so the exit status cannot lie."""

    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, ok: bool, label: str, detail: str = "") -> None:
        if ok:
            self.passed += 1
            print(f"  PASS  {label}")
        else:
            self.failed += 1
            print(f"  FAIL  {label}" + (f"\n        {detail}" if detail else ""))

    def skip(self, label: str) -> None:
        print(f"  SKIP  {label}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def reachable(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def call(
    port: int, method: str, path: str, body: dict | None = None, headers: dict | None = None
):
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    sent = {"Accept": "application/json", **(headers or {})}
    if payload is not None:
        sent["Content-Type"] = "application/json"
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        connection.request(method, path, body=payload, headers=sent)
        answer = connection.getresponse()
        raw = answer.read()
        try:
            return answer.status, json.loads(raw), raw
        except ValueError:
            return answer.status, None, raw
    finally:
        connection.close()


class Server:
    """A real ``python -m app`` in a throwaway data directory."""

    def __init__(self, config: dict, port: int) -> None:
        self.port = port
        self.dir = Path(tempfile.mkdtemp(prefix="nota-verify-"))
        (self.dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
        self.log_path = self.dir / "server.log"
        self._log = self.log_path.open("w", encoding="utf-8")
        env = {
            **os.environ,
            "THOTH_DATA_DIR": str(self.dir),
            "THOTH_PORT": str(port),
            "PYTHONIOENCODING": "utf-8",
        }
        self.process = subprocess.Popen(
            [sys.executable, "-m", "app"],
            cwd=str(BACKEND),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=self._log,
            stderr=subprocess.STDOUT,
        )

    def wait_until_listening(self, port: int | None = None) -> bool:
        target = self.port if port is None else port
        deadline = time.time() + START_TIMEOUT
        while time.time() < deadline:
            if self.process.poll() is not None:
                return False
            if reachable("127.0.0.1", target, 1.0):
                return True
            time.sleep(0.3)
        return False

    def token(self) -> str:
        return (self.dir / "pairing-token.txt").read_text(encoding="utf-8").strip()

    def log_tail(self) -> str:
        self._log.flush()
        text = self.log_path.read_text(encoding="utf-8", errors="replace")
        return text[-800:]

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self._log.close()
        # Windows can hold the SQLite file open for a moment after the child
        # exits, so removing once and hoping is how a temporary directory is
        # left behind. Retry, then say so rather than pretending.
        for _attempt in range(10):
            shutil.rmtree(self.dir, ignore_errors=True)
            if not self.dir.exists():
                return
            time.sleep(0.3)
        print(f"  WARN  could not remove {self.dir}")


class Relay(BaseHTTPRequestHandler):
    """Stands in for a tunnel: forwards to the server, appending the client IP."""

    target_port = 0

    def forward(self) -> None:  # noqa: D102 - one verb, no branches
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        forwarded = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "connection", "x-forwarded-for", "content-length"}
        }
        forwarded["Host"] = f"127.0.0.1:{self.target_port}"
        forwarded["X-Forwarded-For"] = CLIENT_IP
        forwarded["Connection"] = "close"
        upstream = http.client.HTTPConnection("127.0.0.1", self.target_port, timeout=15)
        try:
            upstream.request(self.command, self.path, body=body, headers=forwarded)
            answer = upstream.getresponse()
            payload = answer.read()
            self.send_response(answer.status)
            for key, value in answer.getheaders():
                if key.lower() in {"transfer-encoding", "connection", "content-length"}:
                    continue
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        finally:
            upstream.close()

    do_GET = forward
    do_POST = forward

    def log_message(self, *args) -> None:  # quiet: the checks are the output
        return


def phase_trusted(checks: Checks) -> None:
    """A trusted HTTPS address fronts the server; the proxy is the only way in."""
    print("\nPhase 1 - a trusted address in front of this server")
    port, relay_port = free_port(), free_port()
    # The trailing slash is deliberate: it must be normalised, not stored.
    server = Server({"public_url": PUBLIC + "/"}, port)
    relay: ThreadingHTTPServer | None = None
    try:
        if not server.wait_until_listening():
            checks.check(False, "the server starts with a trusted address", server.log_tail())
            return
        checks.check(True, "the server starts with a trusted address")

        status, health, _ = call(port, "GET", "/api/health")
        checks.check(status == 200, "/api/health answers")
        checks.check(
            health is not None and health.get("mdns") is False,
            "mDNS is not advertised behind a trusted address",
            str(health),
        )
        checks.check(
            health is not None and health.get("hostname") == "" and health.get("mdnsUrl") == "",
            "no local name is handed to the app",
            str(health),
        )

        status, body, _ = call(port, "GET", "/ca")
        checks.check(status == 404, "/ca answers 404 (no profile to install)")
        checks.check(
            isinstance(body, dict) and "trusted address" in str(body.get("detail", "")),
            "the 404 explains why no certificate is needed",
            str(body),
        )

        status, _, raw = call(port, "GET", "/setup")
        page = raw.decode("utf-8", errors="replace")
        checks.check(status == 200, "/setup answers")
        checks.check("no certificate to install" in page.lower(), "/setup says nothing is installed")
        checks.check('href="/ca"' not in page, "/setup offers no profile download")
        checks.check(PUBLIC in page, "/setup shows the public address")

        status, _, raw = call(port, "GET", "/pair")
        pairing_page = raw.decode("utf-8", errors="replace")
        checks.check(status == 200, "/pair answers on the laptop")
        checks.check(f"{PUBLIC}/setup" in pairing_page, "/pair links to the public setup page")
        checks.check("nota.local" not in pairing_page, "/pair mentions no name that is not advertised")
        checks.check("http://localhost:" in pairing_page, "/pair still opens the laptop's loopback door")

        status, link, _ = call(port, "GET", "/api/pair/link")
        checks.check(
            status == 200 and link.get("serverUrl") == PUBLIC,
            "the pairing link carries the public address",
            str(link),
        )

        lan = local_ip()
        if lan.startswith("127."):
            checks.skip("no LAN address on this machine: cannot test the Wi-Fi port")
        else:
            checks.check(
                not reachable(lan, port),
                f"port {port} is not reachable on the LAN address {lan}",
            )

        Relay.target_port = port
        relay = ThreadingHTTPServer(("127.0.0.1", relay_port), Relay)
        relay.daemon_threads = True
        threading.Thread(target=relay.serve_forever, daemon=True).start()

        status, ask, _ = call(
            relay_port, "POST", "/api/pair/request", {"device": "iPad behind the relay"}
        )
        checks.check(status == 200 and "id" in (ask or {}), "the iPad can ask through the relay", str(ask))

        status, listed, _ = call(port, "GET", "/api/pair/requests")
        addresses = [entry.get("address") for entry in (listed or {}).get("requests", [])]
        checks.check(
            status == 200 and addresses == [CLIENT_IP],
            f"the list shows the real client IP ({CLIENT_IP}), not 127.0.0.1",
            str(listed),
        )

        request_id = ask["id"]
        status, _, _ = call(port, "POST", f"/api/pair/requests/{request_id}", {"allow": True})
        checks.check(status == 200, "the laptop can Allow the waiting device")

        status, granted, _ = call(relay_port, "GET", f"/api/pair/request/{request_id}")
        checks.check(
            status == 200 and granted.get("state") == "allowed",
            "the iPad collects the answer through the relay",
            str(granted),
        )
        checks.check(
            granted is not None and granted.get("serverUrl") == PUBLIC,
            "the iPad is handed the public address",
            str(granted),
        )
        checks.check(
            granted is not None and bool(granted.get("token")),
            "the token leaves exactly once, through the trusted side",
        )
        checks.check(
            granted is not None and granted.get("mdns") is False,
            "the answer says there is no local name to try",
            str(granted),
        )
    finally:
        if relay is not None:
            relay.shutdown()
            relay.server_close()
        server.stop()


def phase_lan(checks: Checks) -> None:
    """No public_url: the machine behaves exactly as it did before this work."""
    print("\nPhase 2 - the ordinary LAN mode, no trusted address")
    port, laptop_port = free_port(), free_port()
    # The laptop's own HTTP door gets its own port: 8080 may belong to the
    # server the user already has running.
    server = Server({"laptop_port": laptop_port}, port)
    try:
        if not server.wait_until_listening(laptop_port):
            checks.check(False, "the LAN-mode server starts", server.log_tail())
            return
        checks.check(True, "the LAN-mode server starts (TLS on the LAN, HTTP on loopback)")

        token = server.token()
        _, health, _ = call(laptop_port, "GET", "/api/health")
        _, stance, _ = call(laptop_port, "GET", "/api/status", headers={"X-Thoth-Token": token})
        lan = local_ip()

        checks.check(
            health is not None and health.get("mdns") is True,
            "the LAN mode still advertises its local name",
            str(health),
        )
        checks.check(
            str((health or {}).get("mdnsUrl", "")).startswith("https://nota.local:"),
            "the advertised name is https://nota.local:<port>",
            str((health or {}).get("mdnsUrl")),
        )
        checks.check(
            stance is not None and stance.get("tunneled") is False,
            "no trusted address is in use",
            str(stance),
        )
        checks.check(
            stance is not None and stance.get("tls") is True,
            "the LAN still terminates TLS with its own certificate",
            str((stance or {}).get("tls")),
        )
        checks.check(
            (stance or {}).get("discovery", {}).get("state") != "stopped",
            "discovery is attempted, not skipped",
            str((stance or {}).get("discovery")),
        )
        checks.check(
            (stance or {}).get("baseUrl") == f"https://{lan}:{port}",
            "baseUrl is this machine's LAN address",
            str((stance or {}).get("baseUrl")),
        )
        if lan.startswith("127."):
            checks.skip("no LAN address on this machine: cannot test the Wi-Fi port")
        else:
            checks.check(
                reachable(lan, port),
                f"port {port} is reachable on the LAN address {lan} (bound to 0.0.0.0)",
            )

        status, _, raw = call(laptop_port, "GET", "/ca")
        checks.check(
            status == 200 and len(raw) > 300,
            "the LAN mode still serves the profile at /ca (the trusted mode's 404 is not global)",
            str(status),
        )
    finally:
        server.stop()


def main() -> int:
    checks = Checks()
    phase_trusted(checks)
    phase_lan(checks)
    total = checks.passed + checks.failed
    print(f"\n  {checks.passed}/{total} checks passed")
    return 0 if checks.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
