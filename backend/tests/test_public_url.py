"""The trusted address is a setting the server validates, never guesses.

An ``http://`` address here is not a style preference: iOS refuses to let an
installed web app call one, so a bad value would only surface on the iPad as
"the laptop is asleep". Every rejection therefore has to happen where the value
is set, with words the person typing it can act on.
"""

from __future__ import annotations

import json

import pytest

from app import cli
from app.config import ConfigError, Settings, normalize_public_url, settings


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A throwaway data directory: loading reads config.json from here."""
    monkeypatch.setenv("THOTH_DATA_DIR", str(tmp_path))
    return tmp_path


def test_an_https_address_is_accepted_and_canonicalised():
    assert normalize_public_url("https://JPS-Laptop.Tailnet.ts.net/") == (
        "https://jps-laptop.tailnet.ts.net"
    )
    assert normalize_public_url("  https://nota.example.ts.net:8443  ") == (
        "https://nota.example.ts.net:8443"
    )
    # The trailing slash goes; an explicit port is kept exactly as given.
    assert normalize_public_url("https://nota.example.ts.net:443/") == (
        "https://nota.example.ts.net:443"
    )
    assert normalize_public_url("") == ""
    assert normalize_public_url(None) == ""


@pytest.mark.parametrize(
    "value",
    [
        "http://192.168.1.20:8443",  # iOS blocks this: refused here, not there
        "192.168.1.20:8443",  # no scheme at all
        "ftp://nota.example.ts.net",
        "https:///setup",  # no host
        "https://nota.example.ts.net/setup",  # a path would break every URL built from it
        "https://nota.example.ts.net/?code=1",
        "https://nota.example.ts.net/#sync",
        "https://user:secret@nota.example.ts.net",
        "https://nota.example.ts.net:99999",
        "https://nota example.ts.net",
    ],
)
def test_an_unusable_address_is_refused_with_a_sentence(value):
    with pytest.raises(ConfigError) as refused:
        normalize_public_url(value)
    message = str(refused.value)
    assert message, "a refusal without a reason is not a refusal"
    if value.lower().startswith("http://") or ":" in value.split("//")[0]:
        assert "https://" in message


def test_a_stored_plain_http_address_is_refused_and_the_lan_stays_whole(store):
    (store / "config.json").write_text(
        json.dumps({"public_url": "http://192.168.1.20:8443", "port": 8443}),
        encoding="utf-8",
    )
    cfg = Settings().load()
    assert cfg.public_url == "", "the bad value must not be half-applied"
    assert "https://" in cfg.public_url_problem
    assert cfg.tunneled is False
    # The ordinary LAN mode, exactly as a config without public_url behaves.
    assert cfg.advertises_mdns is True
    assert cfg.listen_host == cfg.host == "0.0.0.0"
    # No certificate exists in this directory, so the LAN falls back to HTTP and
    # the address is the machine's own, never the refused tunnel one.
    assert cfg.base_url.startswith("http://") and cfg.base_url.endswith(":8443")
    assert "192.168.1.20" not in cfg.base_url
    assert cfg.mdns_url == "http://nota.local:8443"


def test_a_stored_https_address_is_loaded_and_canonicalised(store):
    (store / "config.json").write_text(
        json.dumps({"public_url": "https://nota-example.ts.net/"}),
        encoding="utf-8",
    )
    cfg = Settings().load()
    assert cfg.public_url == "https://nota-example.ts.net"
    assert cfg.public_url_problem == ""
    assert cfg.tunneled is True
    assert cfg.tls is False, "a trusted address replaces the local certificate"
    assert cfg.base_url == "https://nota-example.ts.net"
    assert cfg.setup_url == "https://nota-example.ts.net/setup"
    assert cfg.listen_host == "127.0.0.1", "the plain-HTTP port must not answer the Wi-Fi"
    assert cfg.advertises_mdns is False
    assert cfg.mdns_url == ""


def test_a_config_without_a_public_url_keeps_the_lan_behaviour(store):
    (store / "config.json").write_text(json.dumps({"port": 9443}), encoding="utf-8")
    cfg = Settings().load()
    assert cfg.port == 9443
    assert cfg.public_url == ""
    assert cfg.public_url_problem == ""
    assert cfg.tunneled is False
    assert cfg.listen_host == "0.0.0.0"
    assert cfg.advertises_mdns is True
    assert cfg.mdns_url == "http://nota.local:9443"


def test_a_missing_config_file_is_not_a_problem(store):
    cfg = Settings().load()
    assert cfg.public_url == ""
    assert cfg.public_url_problem == ""
    assert cfg.listen_host == "0.0.0.0"


def test_the_reason_is_reported_but_never_written_back(store):
    (store / "config.json").write_text(json.dumps({}), encoding="utf-8")
    cfg = Settings()
    cfg.set_public_url("https://nota-example.ts.net/")
    cfg.save()
    raw = json.loads((store / "config.json").read_text(encoding="utf-8"))
    assert raw["public_url"] == "https://nota-example.ts.net"
    assert "public_url_problem" not in raw, "a report is not a setting"


def test_a_refused_address_leaves_the_previous_one_in_place(store):
    cfg = Settings().load()
    cfg.set_public_url("https://nota-example.ts.net")
    with pytest.raises(ConfigError):
        cfg.set_public_url("http://nota-example.ts.net")
    assert cfg.public_url == "https://nota-example.ts.net"
    assert cfg.tunneled is True


def test_the_cli_refuses_a_plain_http_address_and_stores_nothing(capsys, monkeypatch):
    monkeypatch.setattr(settings, "public_url", "")
    monkeypatch.setattr(settings, "public_url_problem", "")
    monkeypatch.setattr(settings, "save", lambda: None)

    code = cli.main(["public-url", "http://192.168.1.20:8443"])

    assert code == 2
    message = capsys.readouterr().err
    assert "Invalid address" in message
    assert "https://" in message
    assert settings.public_url == ""


def test_the_cli_stores_the_canonical_address(capsys, monkeypatch):
    monkeypatch.setattr(settings, "public_url", "")
    monkeypatch.setattr(settings, "public_url_problem", "")
    monkeypatch.setattr(settings, "save", lambda: None)

    code = cli.main(["public-url", "https://Note-Book.ts.net/"])

    assert code == 0
    assert settings.public_url == "https://note-book.ts.net"
    printed = json.loads(capsys.readouterr().out)
    assert printed["publicUrl"] == "https://note-book.ts.net"
    assert printed["listenHost"] == "127.0.0.1"
    assert printed["mdns"] is False


def test_the_cli_clears_the_address_for_the_lan_mode(capsys, monkeypatch):
    monkeypatch.setattr(settings, "public_url", "https://nota-example.ts.net")
    monkeypatch.setattr(settings, "save", lambda: None)

    assert cli.main(["public-url"]) == 0
    assert settings.public_url == ""
    assert settings.listen_host == "0.0.0.0"
    assert settings.advertises_mdns is True
    assert json.loads(capsys.readouterr().out)["publicUrl"] == ""
