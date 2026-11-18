"""What the server looks like when a trusted address fronts it.

No tunnel is installed here and nothing is exposed: the mode is exercised
through the same application the tunnel would talk to, on the loopback side.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import discovery, pair_requests, pairing
from app.config import settings
from app.main import create_app

PUBLIC = "https://nota-test.ts.net"


@pytest.fixture(autouse=True)
def empty() -> None:
    pair_requests.reset()
    yield
    pair_requests.reset()


@pytest.fixture
def tunnel(monkeypatch):
    """The ordinary app with a trusted address set, as a tunnel would leave it."""
    monkeypatch.setattr(settings, "public_url", PUBLIC)
    monkeypatch.setattr(settings, "public_url_problem", "")
    monkeypatch.setattr(settings, "save", lambda: None)
    discovery.stop()
    application = create_app(settings)
    with TestClient(application) as test_client:
        test_client.headers.update({"X-Thoth-Token": settings.read_token()})
        yield test_client
    discovery.stop()


def test_no_local_name_is_advertised_behind_a_trusted_address(tunnel):
    health = tunnel.get("/api/health").json()
    assert health["ok"] is True
    assert health["mdns"] is False
    assert health["hostname"] == ""
    assert health["mdnsUrl"] == ""
    assert health["serverId"], "the identity still lets the app recognise the laptop"

    status = tunnel.get("/api/status").json()
    assert status["tunneled"] is True
    assert status["mdns"] is False
    assert status["baseUrl"] == PUBLIC
    assert status["laptopUrl"].startswith("http://localhost:")
    assert status["discovery"]["state"] == "stopped", "nothing may be announced on the LAN"


def test_the_plain_http_port_is_bound_to_loopback(tunnel):
    assert settings.listen_host == "127.0.0.1"
    assert settings.advertises_mdns is False


def test_the_certificate_profile_is_gone(tunnel):
    response = tunnel.get("/ca")
    assert response.status_code == 404
    body = response.json()
    assert "trusted address" in body["detail"]
    assert body["baseUrl"] == PUBLIC


def test_the_setup_page_has_nothing_to_install(tunnel):
    body = tunnel.get("/setup").text
    assert "no certificate to install" in body.lower()
    assert 'href="/ca"' not in body
    assert "Certificate Trust Settings" not in body
    assert PUBLIC in body


def test_the_pairing_page_points_at_the_public_address(tunnel):
    body = tunnel.get("/pair").text
    assert f"{PUBLIC}/setup" in body
    assert PUBLIC in body
    assert "nota.local" not in body, "a name the server no longer answers on"
    assert "http://localhost:" in body, "the laptop still opens its own loopback door"


def test_the_pairing_link_carries_the_public_address(tunnel):
    link = tunnel.get("/api/pair/link").json()
    assert link["serverUrl"] == PUBLIC
    assert link["setupUrl"] == f"{PUBLIC}/setup"
    assert link["tunneled"] is True
    # The QR/link path is the fallback when the iPad cannot ask by itself.
    assert "server=https%3A%2F%2Fnota-test.ts.net" in pairing.pairing_link(settings)


def test_a_device_behind_the_proxy_is_listed_with_its_real_ip(tunnel):
    ask = tunnel.post(
        "/api/pair/request",
        json={"device": "iPad loin"},
        headers={"X-Forwarded-For": "100.80.2.3"},
    )
    assert ask.status_code == 200
    listed = tunnel.get("/api/pair/requests").json()["requests"]
    assert [entry["address"] for entry in listed] == ["100.80.2.3"]

    tunnel.post(f"/api/pair/requests/{listed[0]['id']}", json={"allow": True})
    granted = tunnel.get(f"/api/pair/request/{ask.json()['id']}").json()
    assert granted["state"] == "allowed"
    assert granted["serverUrl"] == PUBLIC, "the iPad must be sent to the trusted address"
    assert granted["mdns"] is False
    # Approval mints a token for that device: the laptop's master token stays on
    # the laptop, so this iPad can be revoked without locking anyone else out.
    assert granted["token"]
    assert granted["token"] != settings.read_token()
    assert tunnel.get(
        "/api/status", headers={"X-Thoth-Token": granted["token"]}
    ).status_code == 200
