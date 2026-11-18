"""The iPad path, end to end, on the server's own origin.

An iPad that trusts exactly the root served in the .mobileconfig must be able to
pair and sync against the app served by the laptop itself, with the QR pointing
there. This drives a real TLS listener, so it also proves the certificate is
checked the way iOS checks it, and that the untrusted default context fails.
"""

import http.client
import json
import socket
import ssl
import threading
import time

import pytest
import uvicorn

from app import certs, pairing
from app.config import settings
from app.main import FRONTEND_DIST, create_app


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _request(port: int, context: ssl.SSLContext, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    conn = http.client.HTTPSConnection("127.0.0.1", port, context=context, timeout=10)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, response.read(), dict(response.getheaders())
    finally:
        conn.close()


@pytest.fixture(scope="module")
def ipad_server():
    # mDNS is not what this test is about, and a second registration on the same
    # machine would fail for reasons that have nothing to do with the iPad path.
    import app.discovery as discovery

    real_start, real_stop = discovery.start, discovery.stop
    discovery.start = lambda *a, **k: None
    discovery.stop = lambda *a, **k: None

    certs.ensure_certificates(settings)
    port = _free_port()
    config = uvicorn.Config(
        create_app(),
        host="127.0.0.1",
        port=port,
        log_level="warning",
        ssl_certfile=str(settings.cert_file),
        ssl_keyfile=str(settings.key_file),
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Trust nothing but the root the profile installs: this is the iPad's view.
    context = ssl.create_default_context(cafile=str(settings.ca_pem))
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            status, _, _ = _request(port, context, "GET", "/api/health")
            if status == 200:
                break
        except (OSError, ssl.SSLError):
            time.sleep(0.2)
    else:
        pytest.fail("the local server never answered over TLS")

    try:
        yield port, context
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        discovery.start, discovery.stop = real_start, real_stop


def test_a_client_trusting_only_our_root_can_pair_then_sync(ipad_server):
    port, context = ipad_server
    code = pairing.current_code(settings)

    status, body, _ = _request(
        port,
        context,
        "POST",
        "/api/pair",
        json.dumps({"code": code, "deviceName": "iPad"}).encode(),
        {"Content-Type": "application/json"},
    )
    assert status == 200, body
    token = json.loads(body)["token"]
    assert token == settings.read_token()

    status, body, _ = _request(
        port, context, "GET", "/api/sync/changes?since=0&limit=1", headers={"X-Thoth-Token": token}
    )
    assert status == 200, body
    payload = json.loads(body)
    # Whatever else the shared test database holds, the iPad must be able to
    # read it: a well-formed page of records it can apply locally.
    assert isinstance(payload["records"], list) and payload["hasMore"] is False
    assert payload["cursor"] >= 0
    for record in payload["records"]:
        assert record["id"] and record["deviceId"] and "data" in record

    status, _, _ = _request(
        port, context, "GET", "/api/sync/changes?since=0&limit=1", headers={"X-Thoth-Token": "wrong"}
    )
    assert status == 401, "a wrong token must still be refused on this door"


def test_a_client_trusting_only_system_roots_is_refused(ipad_server):
    port, _ = ipad_server

    with pytest.raises(ssl.SSLError):
        _request(port, ssl.create_default_context(), "GET", "/api/health")


def test_the_same_origin_serves_the_bundle_that_was_built_here(ipad_server):
    port, context = ipad_server
    assert FRONTEND_DIST.exists(), "run npm run build before the backend suite"

    status, body, headers = _request(port, context, "GET", "/")
    assert status == 200
    assert body == (FRONTEND_DIST / "index.html").read_bytes()
    assert headers["content-type"].startswith("text/html")


def test_the_setup_page_points_at_the_app_it_serves(ipad_server):
    port, context = ipad_server
    status, body, headers = _request(port, context, "GET", "/setup")
    assert status == 200
    assert headers["cache-control"] == "no-store"
    page = body.decode()
    assert settings.base_url in page, "the iPad must be told the address it is already on"
    assert 'href="/profile"' in page
    assert 'href="/"' in page, "the setup page opens the app itself"


def test_the_qr_opens_that_same_origin_and_not_github_pages():
    link = pairing.pairing_link(settings)
    assert link.startswith(f"{settings.base_url}/#/sync?")
    assert "server=" in link and "code=" in link
    assert "github.io" not in link
