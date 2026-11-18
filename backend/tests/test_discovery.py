"""Discovery: stable identity, the advertised name, and the health contract."""

from __future__ import annotations

from app import discovery
from app.certs import wanted_names
from app.config import MDNS_HOST, server_identity


def test_server_identity_is_stable_and_address_free():
    first = server_identity()
    second = server_identity()
    assert first == second
    assert len(first) >= 16
    # An identity that looks like an address would be the very thing we removed.
    assert "." not in first


def test_health_announces_its_identity(bare_client):
    payload = bare_client.get("/api/health").json()
    assert payload["ok"] is True
    assert payload["serverId"] == server_identity()
    assert payload["hostname"] == MDNS_HOST


def test_status_reports_discovery_state(client):
    payload = client.get("/api/status").json()
    assert payload["hostname"] == MDNS_HOST
    report = payload["discovery"]
    assert report["hostname"] == MDNS_HOST
    assert report["service"] == discovery.SERVICE_TYPE
    assert report["state"] in {"stopped", "starting", "advertising", "error", "unavailable"}


def test_certificate_covers_the_advertised_name():
    dns, ips = wanted_names()
    assert MDNS_HOST in dns
    assert ips, "the certificate still needs the machine's own address"


def test_describe_before_start_is_honest():
    discovery.stop()
    report = discovery.describe()
    assert report["state"] == "stopped"
    assert report["url"] == ""
    assert report["service"] == discovery.SERVICE_TYPE
