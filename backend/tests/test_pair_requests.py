"""Pairing by approval: the laptop sees the device and says yes."""

import pytest

from app import devices, pair_requests
from app.config import settings


@pytest.fixture(autouse=True)
def empty() -> None:
    pair_requests.reset()
    devices.reset()
    yield
    pair_requests.reset()
    devices.reset()


def ask(bare_client, label: str = "iPad test") -> str:
    response = bare_client.post("/api/pair/request", json={"device": label})
    assert response.status_code == 200
    body = response.json()
    assert body["expiresIn"] == int(pair_requests.REQUEST_TTL)
    return body["id"]


def test_allowing_hands_the_token_over_exactly_once(bare_client, client):
    request_id = ask(bare_client)
    assert len(request_id) > 24, "the id is the only credential, it cannot be guessable"

    waiting = client.get("/api/pair/requests")
    assert waiting.status_code == 200
    listed = waiting.json()["requests"]
    assert [entry["id"] for entry in listed] == [request_id]
    assert listed[0]["device"] == "iPad test"
    assert listed[0]["ageSeconds"] >= 0

    decided = client.post(f"/api/pair/requests/{request_id}", json={"allow": True})
    assert decided.status_code == 200
    assert decided.json()["state"] == "allowed"

    first = bare_client.get(f"/api/pair/request/{request_id}")
    assert first.status_code == 200
    granted = first.json()
    assert granted["state"] == "allowed"
    # Approval is a pairing method like any other: the device gets its own
    # token, so it can be revoked without disturbing the laptop's master one.
    assert granted["token"]
    assert granted["token"] != settings.read_token()
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": granted["token"]}
    ).status_code == 200
    assert granted["serverUrl"].startswith("http")

    again = bare_client.get(f"/api/pair/request/{request_id}")
    assert again.status_code == 200
    assert again.json() == {"state": "claimed"}


def test_refusing_never_reveals_the_token(bare_client, client):
    request_id = ask(bare_client)
    client.post(f"/api/pair/requests/{request_id}", json={"allow": False})

    answer = bare_client.get(f"/api/pair/request/{request_id}")
    assert answer.status_code == 200
    assert answer.json() == {"state": "denied"}
    assert "token" not in answer.text
    assert request_id not in [entry["id"] for entry in client.get("/api/pair/requests").json()["requests"]]


def test_a_waiting_request_is_listed_before_any_decision(bare_client, client):
    request_id = ask(bare_client, "iPad salle")
    pending = bare_client.get(f"/api/pair/request/{request_id}")
    assert pending.status_code == 200
    assert pending.json() == {"state": "pending"}
    # Polling does not consume anything, and the list still shows it.
    assert [entry["id"] for entry in client.get("/api/pair/requests").json()["requests"]] == [request_id]


def test_unknown_or_expired_requests_answer_404(bare_client):
    assert bare_client.get("/api/pair/request/not-a-request").status_code == 404


def test_requests_expire_after_five_minutes(bare_client, client, monkeypatch):
    request_id = ask(bare_client)
    moment = [pair_requests._now() + pair_requests.REQUEST_TTL + 1]
    monkeypatch.setattr(pair_requests, "_now", lambda: moment[0])

    assert client.get("/api/pair/requests").json()["requests"] == []
    assert bare_client.get(f"/api/pair/request/{request_id}").status_code == 404


def test_a_device_cannot_knock_forever(bare_client):
    for _ in range(pair_requests.MAX_PER_CLIENT):
        assert bare_client.post("/api/pair/request", json={"device": "noise"}).status_code == 200
    blocked = bare_client.post("/api/pair/request", json={"device": "noise"})
    assert blocked.status_code == 429


def test_a_refused_request_says_how_long_to_wait(bare_client):
    for _ in range(pair_requests.MAX_PER_CLIENT):
        assert bare_client.post("/api/pair/request", json={"device": "noise"}).status_code == 200

    blocked = bare_client.post("/api/pair/request", json={"device": "noise"})

    assert blocked.status_code == 429
    seconds = int(blocked.headers["retry-after"])
    assert 0 < seconds <= pair_requests.CREATE_WINDOW
    assert f"Try again in {seconds} seconds" in blocked.json()["detail"]


def test_the_published_app_can_read_the_wait(bare_client):
    """The iPad runs from GitHub Pages: a cross-origin header must be exposed."""
    origin = {"Origin": "https://jupomiii.github.io"}
    for _ in range(pair_requests.MAX_PER_CLIENT):
        bare_client.post("/api/pair/request", json={"device": "noise"}, headers=origin)

    blocked = bare_client.post("/api/pair/request", json={"device": "noise"}, headers=origin)

    assert blocked.status_code == 429
    exposed = blocked.headers.get("access-control-expose-headers", "").lower()
    assert "retry-after" in exposed, exposed


def test_the_wait_counts_down_instead_of_repeating_the_window(monkeypatch):
    moment = [1000.0]
    monkeypatch.setattr(pair_requests, "_now", lambda: moment[0])
    for _ in range(pair_requests.MAX_PER_CLIENT):
        pair_requests.create("iPad", "192.168.2.9")

    assert pair_requests.retry_after("192.168.2.9") == pair_requests.CREATE_WINDOW

    moment[0] += 120
    assert pair_requests.retry_after("192.168.2.9") == pair_requests.CREATE_WINDOW - 120
    # A device that has not knocked yet is not waiting for anything.
    assert pair_requests.retry_after("10.0.0.1") == 0


def test_only_the_laptop_can_list_or_answer_requests(bare_client, monkeypatch):
    request_id = ask(bare_client)
    monkeypatch.setattr("app.api.routes.is_self_client", lambda host: False)

    assert bare_client.get("/api/pair/requests").status_code == 403
    denied = bare_client.post(f"/api/pair/requests/{request_id}", json={"allow": True})
    assert denied.status_code == 403
    # Still unanswered, so still no token.
    assert bare_client.get(f"/api/pair/request/{request_id}").json() == {"state": "pending"}


def test_the_label_is_only_a_label(bare_client, client):
    long_label = "iPad " + "x" * 40 + "\n\t\u0000"
    request_id = ask(bare_client, long_label)
    listed = client.get("/api/pair/requests").json()["requests"]
    assert listed[0]["id"] == request_id
    assert len(listed[0]["device"]) <= pair_requests.LABEL_LIMIT
    assert "\n" not in listed[0]["device"]


def test_the_laptop_is_handed_its_own_plain_http_door(bare_client, client):
    """No certificate on the laptop: a request that came from loopback gets the
    loopback address back, never the LAN one that needs the iPad's profile."""
    request_id = ask(bare_client)
    client.post(f"/api/pair/requests/{request_id}", json={"allow": True})
    granted = bare_client.get(f"/api/pair/request/{request_id}").json()
    assert granted["serverUrl"] == settings.laptop_app_url
    assert granted["serverUrl"].startswith("http://")
    assert not granted["serverUrl"].startswith("https://")


def test_a_device_on_the_lan_is_handed_the_lan_address(bare_client):
    entry = pair_requests.create("iPad loin", "192.168.2.50")
    pair_requests.decide(entry.id, True)
    granted = bare_client.get(f"/api/pair/request/{entry.id}").json()
    assert granted["state"] == "allowed"
    assert granted["serverUrl"] == settings.base_url
    assert granted["token"] != settings.read_token()
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": granted["token"]}
    ).status_code == 200


def test_an_approved_device_without_a_key_replaces_its_old_token(bare_client, client):
    """The main path, with a bundle that predates device keys."""
    tokens = []
    for _ in range(2):
        request_id = ask(bare_client)
        bare_client.post(f"/api/pair/requests/{request_id}", json={"allow": True})
        tokens.append(bare_client.get(f"/api/pair/request/{request_id}").json()["token"])

    assert tokens[0] != tokens[1]
    assert len(client.get("/api/devices").json()["devices"]) == 1
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": tokens[0]}
    ).status_code == 401, "the first pairing's token stops working the moment it pairs again"
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": tokens[1]}
    ).status_code == 200


def test_approving_the_same_device_twice_keeps_one_row(bare_client, client):
    for _ in range(2):
        request_id = bare_client.post(
            "/api/pair/request", json={"device": "iPad twice", "deviceKey": "ipad-same-key"}
        ).json()["id"]
        bare_client.post(f"/api/pair/requests/{request_id}", json={"allow": True})
        assert bare_client.get(f"/api/pair/request/{request_id}").json()["token"]

    assert len(client.get("/api/devices").json()["devices"]) == 1


def test_an_approved_device_can_be_revoked_like_a_scanned_one(bare_client, client):
    request_id = ask(bare_client, "iPad approved")
    client.post(f"/api/pair/requests/{request_id}", json={"allow": True})
    granted = bare_client.get(f"/api/pair/request/{request_id}").json()

    listed = client.get("/api/devices").json()["devices"]
    target = next(entry for entry in listed if entry["label"] == "iPad approved")
    assert client.post(f"/api/devices/{target['id']}/revoke").status_code == 200

    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": granted["token"]}
    ).status_code == 401


def test_answering_a_request_twice_is_refused(bare_client, client):
    request_id = ask(bare_client)
    assert client.post(f"/api/pair/requests/{request_id}", json={"allow": True}).status_code == 200
    assert client.post(f"/api/pair/requests/{request_id}", json={"allow": True}).status_code == 404
