"""The trust profile must be the shape iOS installs, not a bare certificate."""

import plistlib

import pytest

from app import certs
from app.config import Settings
from app.profile import build_profile


@pytest.fixture
def cfg(tmp_path, monkeypatch) -> Settings:
    monkeypatch.setenv("THOTH_DATA_DIR", str(tmp_path))
    return Settings().load()


def test_the_profile_carries_the_ca_as_a_root_certificate():
    der = b"\x30\x82\x01\x0a" + b"fake-der" * 20
    payload = plistlib.loads(build_profile(der))

    assert payload["PayloadType"] == "Configuration"
    assert payload["PayloadIdentifier"] == "com.thoth.notes.local-ca"
    assert payload["PayloadUUID"]
    inner = payload["PayloadContent"][0]
    assert inner["PayloadType"] == "com.apple.security.root"
    assert inner["PayloadContent"] == der
    assert inner["PayloadUUID"] != payload["PayloadUUID"]


def test_each_build_gets_its_own_identifiers():
    first = plistlib.loads(build_profile(b"a"))
    second = plistlib.loads(build_profile(b"a"))
    assert first["PayloadUUID"] != second["PayloadUUID"]


def test_the_route_serves_a_mobileconfig_with_the_ca_inside(bare_client, cfg):
    certs.ensure_certificates(cfg)
    response = bare_client.get("/profile")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-apple-aspen-config")
    assert ".mobileconfig" in response.headers["content-disposition"]
    body = plistlib.loads(response.content)
    assert body["PayloadContent"][0]["PayloadContent"] == cfg.ca_file.read_bytes()


def test_the_route_says_so_when_no_certificate_exists(tmp_path, monkeypatch):
    """A fresh data directory has no authority yet, so there is no profile."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    monkeypatch.setenv("THOTH_DATA_DIR", str(tmp_path))
    monkeypatch.setattr("app.discovery.start", lambda *a, **k: None)
    monkeypatch.setattr("app.discovery.stop", lambda *a, **k: None)
    cfg = Settings().load()
    with TestClient(create_app(cfg)) as fresh:
        assert fresh.get("/profile").status_code == 404
