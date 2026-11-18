"""Pairing by QR code: one secret, one proof, one code for two eyes.

The QR code is the only thing that crosses from the laptop to the iPad, and it
carries a secret that dies after five minutes or three wrong attempts. What
comes back is a proof, never the secret. The five-character code exists so a
person can see that both screens used the same secret; it is not a credential.
"""

from __future__ import annotations

import hashlib
import logging

import pytest
from fastapi.testclient import TestClient

from app import devices, pair_session
from app.database.db import connection
from app.config import settings
from app.main import create_app


@pytest.fixture(autouse=True)
def clean() -> None:
    pair_session.reset()
    devices.reset()
    yield
    pair_session.reset()
    devices.reset()


def scan(bare_client) -> tuple[str, str, str]:
    """What the iPad reads in the QR code: session id, secret, confirmation code."""
    body = bare_client.get("/api/pair/link").json()
    return body["sessionId"], body["secret"], body["confirmCode"]


def claim(bare_client, session_id: str, proof: str, label: str = "iPad test"):
    return bare_client.post(
        "/api/pair/session",
        json={"id": session_id, "proof": proof, "deviceName": label},
    )


def test_the_qr_carries_a_256_bit_secret_and_a_five_character_code(bare_client):
    session_id, secret, code = scan(bare_client)

    assert len(secret.encode("utf-8")) >= 32, "at least 256 bits, twice the 128-bit floor"
    assert len(code) == pair_session.CODE_LENGTH == 5
    assert set(code) <= set(pair_session.ALPHABET)
    # The alphabet has to survive being read across two screens.
    assert not set(code) & set("01OIL")
    assert secret not in session_id
    assert len(session_id) >= 8


def test_the_link_keeps_the_secret_in_the_fragment(bare_client):
    """A fragment is never sent to a server, so the secret never reaches a log."""
    _, secret, _ = scan(bare_client)
    link = bare_client.get("/api/pair/link").json()["link"]

    assert link.split("#", 1)[1].startswith("/sync?")
    assert f"s={secret}" in link.split("#", 1)[1]
    assert secret not in link.split("#", 1)[0]


def test_the_right_proof_pairs_once_and_the_code_matches(bare_client):
    session_id, secret, code = scan(bare_client)

    response = claim(bare_client, session_id, pair_session.proof_for(secret, session_id))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["token"]
    # A device gets a token of its own, not the laptop's master token.
    assert body["token"] != settings.read_token()
    assert body["code"] == code
    assert body["serverUrl"].startswith("http")

    again = claim(bare_client, session_id, pair_session.proof_for(secret, session_id))
    assert again.status_code == 409, "a QR code pairs one device, once"


def test_the_secret_itself_never_travels(bare_client):
    session_id, secret, _ = scan(bare_client)
    proof = pair_session.proof_for(secret, session_id)

    assert proof != secret
    assert len(proof) == 64
    assert secret not in proof
    # A proof is bound to its session: the next QR code rejects this one.
    assert pair_session.proof_for(secret, "a-different-session") != proof


def test_a_proof_off_by_one_character_is_refused(bare_client):
    session_id, secret, _ = scan(bare_client)
    proof = pair_session.proof_for(secret, session_id)
    tampered = ("f" if proof[0] != "f" else "0") + proof[1:]

    assert tampered != proof
    assert claim(bare_client, session_id, tampered).status_code == 401


def test_a_proof_for_another_secret_is_refused(bare_client):
    session_id, _secret, _code = scan(bare_client)

    response = claim(bare_client, session_id, pair_session.proof_for("not-the-secret", session_id))

    assert response.status_code == 401
    assert "token" not in response.text


def test_three_wrong_proofs_invalidate_the_qr_code(bare_client):
    session_id, secret, _ = scan(bare_client)
    good = pair_session.proof_for(secret, session_id)
    wrong = "0" * 64

    assert claim(bare_client, session_id, wrong).status_code == 401
    assert claim(bare_client, session_id, wrong).status_code == 401
    locked = claim(bare_client, session_id, wrong)
    assert locked.status_code == 429
    assert "new QR code" in locked.json()["detail"]

    # The right proof is worthless now: the laptop has to show a new QR code.
    assert claim(bare_client, session_id, good).status_code == 401
    fresh_id, _fresh_secret, _fresh_code = scan(bare_client)
    assert fresh_id != session_id


def test_an_expired_qr_code_is_refused(bare_client, monkeypatch):
    session_id, secret, _ = scan(bare_client)
    moment = [pair_session._now() + pair_session.SESSION_TTL + 1]
    monkeypatch.setattr(pair_session, "_now", lambda: moment[0])

    response = claim(bare_client, session_id, pair_session.proof_for(secret, session_id))

    assert response.status_code == 410
    assert "expired" in response.json()["detail"]


def test_the_session_expires_after_five_minutes(bare_client, monkeypatch):
    first_id, _secret, _code = scan(bare_client)
    assert pair_session.SESSION_TTL == 300
    moment = [pair_session._now() + pair_session.SESSION_TTL + 1]
    monkeypatch.setattr(pair_session, "_now", lambda: moment[0])

    second_id, _secret2, _code2 = scan(bare_client)
    assert second_id != first_id, "a fresh QR code, not the expired one"


def test_an_unknown_session_is_refused(bare_client):
    response = claim(bare_client, "made-up-session", "a" * 64)
    assert response.status_code == 401
    assert "token" not in response.text


def test_a_claim_without_a_proof_is_refused_before_any_lookup(bare_client):
    session_id, _secret, _code = scan(bare_client)

    missing = bare_client.post("/api/pair/session", json={"id": session_id})
    short = bare_client.post("/api/pair/session", json={"id": session_id, "proof": "abc"})

    assert missing.status_code == 422
    assert short.status_code == 422


def test_a_paired_device_carries_its_own_token_and_keeps_working(bare_client):
    session_id, secret, _ = scan(bare_client)
    granted = claim(bare_client, session_id, pair_session.proof_for(secret, session_id)).json()

    status = bare_client.get("/api/status", headers={"X-Thoth-Token": granted["token"]})

    assert status.status_code == 200
    assert granted["token"] not in status.text


def test_revoking_one_device_leaves_the_other_working(bare_client, client):
    first_id, first_secret, _ = scan(bare_client)
    first = claim(
        bare_client, first_id, pair_session.proof_for(first_secret, first_id), "iPad one"
    ).json()
    second_id, second_secret, _ = scan(bare_client)
    second = claim(
        bare_client, second_id, pair_session.proof_for(second_secret, second_id), "iPad two"
    ).json()
    assert first["token"] != second["token"]

    listed = client.get("/api/devices").json()["devices"]
    target = next(entry for entry in listed if entry["label"] == "iPad two")
    assert target["revoked"] is False

    revoked = client.post(f"/api/devices/{target['id']}/revoke")
    assert revoked.status_code == 200 and revoked.json() == {"ok": True}

    assert bare_client.get("/api/status", headers={"X-Thoth-Token": second["token"]}).status_code == 401
    assert bare_client.get("/api/status", headers={"X-Thoth-Token": first["token"]}).status_code == 200
    # Revoking twice is a 404, not a silent success.
    assert client.post(f"/api/devices/{target['id']}/revoke").status_code == 404


def test_pairing_again_replaces_the_token_instead_of_adding_a_device(bare_client, client):
    first_id, first_secret, _ = scan(bare_client)
    first = bare_client.post(
        "/api/pair/session",
        json={
            "id": first_id,
            "proof": pair_session.proof_for(first_secret, first_id),
            "deviceName": "iPad one",
            "deviceKey": "ipad-stable-key",
        },
    ).json()
    second_id, second_secret, _ = scan(bare_client)
    second = bare_client.post(
        "/api/pair/session",
        json={
            "id": second_id,
            "proof": pair_session.proof_for(second_secret, second_id),
            "deviceName": "iPad one",
            "deviceKey": "ipad-stable-key",
        },
    ).json()

    listed = client.get("/api/devices").json()["devices"]
    assert len(listed) == 1, "one device, not one more row per pairing"
    assert second["token"] != first["token"]
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": first["token"]}
    ).status_code == 401, "the replaced token is gone"
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": second["token"]}
    ).status_code == 200


def test_pairing_again_from_another_address_replaces_the_token_by_key(bare_client, client):
    """The iPad's address changes; its device key does not. One device, one token.

    A new Wi-Fi network gives the same app a new address, so the label and
    address must not be the thing that decides here: only the key can tie the
    two pairings to one device, and the old token must stop working.
    """
    session_id, secret, _ = scan(bare_client)
    first = bare_client.post(
        "/api/pair/session",
        json={
            "id": session_id,
            "proof": pair_session.proof_for(secret, session_id),
            "deviceName": "iPad moving",
            "deviceKey": "ipad-moved-key",
        },
    ).json()

    elsewhere = TestClient(bare_client.app, client=("10.20.30.40", 5000))
    session_id, secret, _ = scan(bare_client)
    second = elsewhere.post(
        "/api/pair/session",
        json={
            "id": session_id,
            "proof": pair_session.proof_for(secret, session_id),
            "deviceName": "iPad moving",
            "deviceKey": "ipad-moved-key",
        },
    )

    assert second.status_code == 200, second.text
    listed = client.get("/api/devices").json()["devices"]
    assert len(listed) == 1, "the same key is the same device, whatever address it comes from"
    assert listed[0]["address"] == "10.20.30.40", "the row follows the device to its new address"
    assert second.json()["token"] != first["token"]
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": first["token"]}
    ).status_code == 401, "pairing from the new address retires the old token"
    assert elsewhere.get(
        "/api/status", headers={"X-Thoth-Token": second.json()["token"]}
    ).status_code == 200


def test_pairing_again_without_a_key_replaces_the_old_token(bare_client, client):
    """An older copy sends no device key: label and address must still match."""
    first_id, first_secret, _ = scan(bare_client)
    first = claim(bare_client, first_id, pair_session.proof_for(first_secret, first_id), "iPad no key").json()
    second_id, second_secret, _ = scan(bare_client)
    second = claim(bare_client, second_id, pair_session.proof_for(second_secret, second_id), "iPad no key")

    assert second.status_code == 200
    assert len(client.get("/api/devices").json()["devices"]) == 1, "one row per device, not one per pairing"
    old = bare_client.get("/api/status", headers={"X-Thoth-Token": first["token"]})
    assert old.status_code == 401, "pairing again must retire the previous token"
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": second.json()["token"]}
    ).status_code == 200


def test_pairing_again_retires_rows_stacked_by_earlier_pairings(bare_client, client):
    """Duplicates left by an older build stop working the next time they pair."""
    session_id, secret, _ = scan(bare_client)
    first = claim(bare_client, session_id, pair_session.proof_for(secret, session_id), "iPad stacked").json()
    address = client.get("/api/devices").json()["devices"][0]["address"]
    with connection() as conn:
        for index in range(2):
            conn.execute(
                "INSERT INTO devices (id, label, address, token_hash, created_at, last_seen_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    f"stacked{index}",
                    "iPad stacked",
                    address,
                    hashlib.sha256(f"stacked-token-{index}".encode()).hexdigest(),
                    1,
                    1,
                ),
            )
    devices.refresh()
    assert len(client.get("/api/devices").json()["devices"]) == 3

    session_id, secret, _ = scan(bare_client)
    again = claim(bare_client, session_id, pair_session.proof_for(secret, session_id), "iPad stacked")

    listed = client.get("/api/devices").json()["devices"]
    assert len(listed) == 3, "the rows are kept, but only one still has a token"
    assert [entry["revoked"] for entry in listed].count(False) == 1
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": first["token"]}
    ).status_code == 401, "the token that row held before is gone too"
    for index in range(2):
        assert bare_client.get(
            "/api/status", headers={"X-Thoth-Token": f"stacked-token-{index}"}
        ).status_code == 401
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": again.json()["token"]}
    ).status_code == 200


def test_pairing_again_brings_a_revoked_device_back(bare_client, client):
    first_id, first_secret, _ = scan(bare_client)
    first = bare_client.post(
        "/api/pair/session",
        json={
            "id": first_id,
            "proof": pair_session.proof_for(first_secret, first_id),
            "deviceName": "iPad back",
            "deviceKey": "ipad-returning",
        },
    ).json()
    listed = client.get("/api/devices").json()["devices"]
    client.post(f"/api/devices/{listed[0]['id']}/revoke")
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": first["token"]}
    ).status_code == 401

    second_id, second_secret, _ = scan(bare_client)
    second = bare_client.post(
        "/api/pair/session",
        json={
            "id": second_id,
            "proof": pair_session.proof_for(second_secret, second_id),
            "deviceName": "iPad back",
            "deviceKey": "ipad-returning",
        },
    )

    assert second.status_code == 200
    listed = client.get("/api/devices").json()["devices"]
    assert len(listed) == 1
    assert listed[0]["revoked"] is False, "pairing again is the reader saying 'this one again'"
    assert bare_client.get(
        "/api/status", headers={"X-Thoth-Token": second.json()["token"]}
    ).status_code == 200


def test_a_revoked_device_is_told_it_was_removed(bare_client, client):
    session_id, secret, _ = scan(bare_client)
    granted = claim(bare_client, session_id, pair_session.proof_for(secret, session_id), "iPad gone").json()
    listed = client.get("/api/devices").json()["devices"]
    client.post(f"/api/devices/{listed[0]['id']}/revoke")

    refused = bare_client.get("/api/status", headers={"X-Thoth-Token": granted["token"]})

    assert refused.status_code == 401
    body = refused.json()
    assert body["code"] == "revoked", "the app must not send the reader hunting for a token"
    assert "removed on the laptop" in body["detail"]


def test_a_wrong_token_is_not_reported_as_a_removed_device(bare_client):
    refused = bare_client.get("/api/status", headers={"X-Thoth-Token": "not-a-real-token"})

    assert refused.status_code == 401
    assert "code" not in refused.json()


def test_only_the_laptop_lists_or_revokes_devices(bare_client, monkeypatch):
    # The token gets past the middleware; the *address* is what refuses it, so a
    # paired iPad cannot revoke its neighbours.
    headers = {"X-Thoth-Token": settings.read_token()}
    monkeypatch.setattr("app.api.routes.is_self_client", lambda host: False)

    assert bare_client.get("/api/devices", headers=headers).status_code == 403
    assert bare_client.post("/api/devices/whatever/revoke", headers=headers).status_code == 403


def test_listing_or_revoking_needs_a_token(bare_client):
    """The laptop's own pages stopped reading this list, so the door closes again."""
    listed = bare_client.get("/api/devices")
    revoked = bare_client.post("/api/devices/whatever/revoke")

    assert listed.status_code == 401
    assert revoked.status_code == 401
    assert "code" not in listed.json()


def test_neither_the_secret_nor_the_token_reaches_the_log(bare_client, caplog):
    caplog.set_level(logging.DEBUG)
    session_id, secret, code = scan(bare_client)
    proof = pair_session.proof_for(secret, session_id)
    granted = claim(bare_client, session_id, proof).json()

    messages = "\n".join(
        record.getMessage() for record in caplog.records if record.name.startswith("thoth")
    )
    assert secret not in messages
    assert proof not in messages
    assert granted["token"] not in messages
    assert code not in messages


def test_a_public_client_never_reaches_the_pairing_endpoint():
    """The server binds the LAN and refuses anything that is not a private peer.

    The address is set on the transport rather than on the app, so the request
    really arrives from a public peer and the middleware is the thing under test.
    """
    import asyncio

    import httpx

    # A genuinely public peer: 203.0.113.0/24 is TEST-NET-3, which Python's
    # ipaddress module (rightly) calls private, so it would not prove anything.
    transport = httpx.ASGITransport(app=create_app(), client=("8.8.8.8", 51234))

    async def call() -> tuple[int, int]:
        async with httpx.AsyncClient(transport=transport, base_url="http://nota.test") as client:
            health = await client.get("/api/health")
            claim_response = await client.post(
                "/api/pair/session", json={"id": "x" * 12, "proof": "a" * 64}
            )
            return health.status_code, claim_response.status_code

    health_status, claim_status = asyncio.run(call())
    assert health_status == 403
    assert claim_status == 403


def test_the_pairing_page_shows_the_confirmation_code(bare_client):
    page = bare_client.get("/pair")
    if page.status_code == 404:
        pytest.skip("no frontend build in this environment")
    current = bare_client.get("/api/pair/link").json()["confirmCode"]
    assert current in page.text
