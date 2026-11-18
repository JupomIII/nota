"""Reconnection: the laptop sleeps, restarts, and comes back at another address.

A device token has to outlive all three. If it did not, every overnight sleep
would mean scanning a fresh QR code, which is exactly the friction this pairing
flow exists to remove.

These tests run real Uvicorn servers on real sockets, one after the other, all
sharing one data directory — the same laptop seen at three addresses.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from app import devices, pair_session
from app.database.db import init_db

BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def clean() -> None:
    # These tests drive real servers, so they never touch the session-scoped
    # TestClient that would otherwise create the schema for them.
    init_db()
    pair_session.reset()
    devices.reset()
    yield
    pair_session.reset()
    devices.reset()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Running:
    """One laptop address, up for the length of a ``with`` block.

    A real process, not a thread: "the laptop slept" has to mean the in-memory
    state is gone, otherwise the test would be measuring a shared dictionary.
    The data directory is inherited from the test environment, so every process
    here is the same laptop.
    """

    def __init__(self, port: int) -> None:
        self.port = port
        env = dict(os.environ)
        env["THOTH_PORT"] = str(port)
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
            cwd=str(BACKEND_DIR),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def __enter__(self) -> "Running":
        deadline = time.time() + 40
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"the test server exited with {self.proc.returncode}")
            try:
                if httpx.get(self.url("/api/health"), timeout=1).status_code == 200:
                    return self
            except httpx.TransportError:
                pass
            time.sleep(0.1)
        raise RuntimeError("the test server never answered")

    def __exit__(self, *_exc) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:  # pragma: no cover - a stuck process
            self.proc.kill()
            self.proc.wait(timeout=10)

    def url(self, path: str = "") -> str:
        return f"http://127.0.0.1:{self.port}{path}"


def scan(server: Running) -> tuple[str, str]:
    """What the iPad reads in the QR code: the session and its secret."""
    link = httpx.get(server.url("/api/pair/link"), timeout=5).json()
    return link["sessionId"], link["secret"]


def pair(server: Running, label: str = "iPad reconnect") -> dict:
    session_id, secret = scan(server)
    response = httpx.post(
        server.url("/api/pair/session"),
        json={"id": session_id, "proof": pair_session.proof_for(secret, session_id), "deviceName": label},
        timeout=5,
    )
    assert response.status_code == 200, response.text
    return response.json()


def status(server: Running, token: str) -> int:
    return httpx.get(
        server.url("/api/status"), headers={"X-Thoth-Token": token}, timeout=5
    ).status_code


def test_a_paired_device_survives_a_sleep_and_a_new_address():
    first = free_port()
    with Running(first) as laptop:
        granted = pair(laptop)
        identity = httpx.get(laptop.url("/api/health"), timeout=5).json()["serverId"]
        assert status(laptop, granted["token"]) == 200

    # The laptop is asleep, off, or off the network: that address is gone.
    with pytest.raises(httpx.TransportError):
        httpx.get(
            f"http://127.0.0.1:{first}/api/status",
            headers={"X-Thoth-Token": granted["token"]},
            timeout=1,
        )

    # It comes back with a new address (new DHCP lease, or a new port here).
    second = free_port()
    assert second != first
    with Running(second) as laptop:
        moved = httpx.get(laptop.url("/api/health"), timeout=5).json()
        assert moved["serverId"] == identity, "the same laptop, at another address"
        assert status(laptop, granted["token"]) == 200, "the token still works: no new QR code"
        listed = httpx.get(
            laptop.url("/api/devices"), headers={"X-Thoth-Token": granted["token"]}, timeout=5
        ).json()["devices"]
        assert [entry["label"] for entry in listed] == ["iPad reconnect"]
        assert listed[0]["revoked"] is False


def test_the_qr_code_does_not_survive_a_restart_but_the_device_does():
    """A session lives in memory: a crash costs one scan, not the pairing."""
    first = free_port()
    with Running(first) as laptop:
        session_id, secret = scan(laptop)
        granted = httpx.post(
            laptop.url("/api/pair/session"),
            json={
                "id": session_id,
                "proof": pair_session.proof_for(secret, session_id),
                "deviceName": "iPad restart",
            },
            timeout=5,
        ).json()

    second = free_port()
    with Running(second) as laptop:
        # The QR code that paired it is gone with the process that issued it.
        stale = httpx.post(
            laptop.url("/api/pair/session"),
            json={"id": session_id, "proof": pair_session.proof_for(secret, session_id)},
            timeout=5,
        )
        assert stale.status_code == 401
        # The device itself is not: its token was written to the database.
        assert status(laptop, granted["token"]) == 200


def test_a_revocation_outlives_a_restart():
    first = free_port()
    with Running(first) as laptop:
        granted = pair(laptop, "iPad revoked")
        listed = httpx.get(
            laptop.url("/api/devices"), headers={"X-Thoth-Token": granted["token"]}, timeout=5
        ).json()["devices"]
        revoked = httpx.post(
            laptop.url(f"/api/devices/{listed[0]['id']}/revoke"),
            headers={"X-Thoth-Token": granted["token"]},
            timeout=5,
        )
        assert revoked.status_code == 200
        assert status(laptop, granted["token"]) == 401

    second = free_port()
    with Running(second) as laptop:
        # Revoking is a decision, not a cache entry: a restart cannot undo it.
        assert status(laptop, granted["token"]) == 401
