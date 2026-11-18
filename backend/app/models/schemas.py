"""Pydantic models shared by the sync API. Mirrors shared/schemas/sync.schema.json."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

SyncKind = Literal[
    "folder",
    "notebook",
    "page",
    "stroke",
    "text",
    "image",
    "equation",
    "graph",
    "table",
    "asset",
]
SYNC_KINDS: tuple[str, ...] = (
    "folder",
    "notebook",
    "page",
    "stroke",
    "text",
    "image",
    "equation",
    "graph",
    "table",
    "asset",
)

MAX_RECORD_BYTES = 3 * 1024 * 1024


class SyncRecord(BaseModel):
    kind: SyncKind
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    data: dict[str, Any]
    createdAt: int = Field(ge=0)
    updatedAt: int = Field(ge=0)
    version: int = Field(ge=0, le=10_000_000)
    deviceId: str = Field(default="", max_length=128)
    deletedAt: int | None = None

    @field_validator("data")
    @classmethod
    def data_is_bounded(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value)) > MAX_RECORD_BYTES:
            raise ValueError("record payload exceeds 3 MiB")
        return value


class PushRequest(BaseModel):
    deviceId: str = Field(min_length=1, max_length=128)
    records: list[SyncRecord] = Field(default_factory=list, max_length=500)


class AcceptedRecord(BaseModel):
    kind: SyncKind
    id: str
    version: int
    updatedAt: int


class PushConflict(BaseModel):
    kind: SyncKind
    id: str
    server: SyncRecord
    client: SyncRecord


class PushResponse(BaseModel):
    accepted: list[AcceptedRecord]
    conflicts: list[PushConflict]
    cursor: int
    serverTime: int


class ChangesResponse(BaseModel):
    records: list[SyncRecord]
    cursor: int
    hasMore: bool


class HealthResponse(BaseModel):
    ok: bool
    name: str
    version: int
    deviceName: str
    time: int
    # The address this laptop opens the app on; the iPad shows it verbatim.
    laptopUrl: str = ""
    # Identity of this server, stable across networks. The iPad stores it beside
    # its pairing token so a new address is still the same server.
    serverId: str = ""
    # The mDNS name clients should try first, and the port it is advertised on:
    # a browser cannot read Bonjour's SRV record, so it learns the port here.
    # Both are empty behind a trusted address, where nothing is advertised.
    hostname: str = ""
    mdnsUrl: str = ""
    # False when this server advertises no local name at all, so the app can
    # skip the name instead of probing it on every reconnect.
    mdns: bool = True


class PairRequest(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    deviceName: str = Field(default="", max_length=120)


class PairStart(BaseModel):
    """A device asking to pair: a label for the laptop, and its stable id."""

    device: str = Field(default="", max_length=60)
    # The app's own device id. Pairing again with the same key replaces the
    # device's token instead of adding a second entry to the list.
    deviceKey: str = Field(default="", max_length=128)


class PairDecision(BaseModel):
    allow: bool


class SessionClaim(BaseModel):
    """A device proving it scanned this laptop's QR code.

    ``proof`` is an HMAC of the session id keyed by the secret from the QR: the
    secret itself never crosses the network.
    """

    id: str = Field(min_length=8, max_length=64)
    proof: str = Field(min_length=32, max_length=128)
    deviceName: str = Field(default="", max_length=120)
    # The app's own device id, so pairing again replaces rather than stacks.
    deviceKey: str = Field(default="", max_length=128)


class PairResponse(BaseModel):
    token: str
    serverUrl: str
    deviceName: str
    # Whether the laptop answers under nota.local too; false behind a tunnel.
    mdns: bool = True
    # The five-character code the laptop shows, for a human to compare. Empty
    # from servers that only know the rotating six-character code.
    code: str = ""


class BackupInfo(BaseModel):
    name: str
    size: int
    createdAt: int


class ImportResult(BaseModel):
    ok: bool
    inserted: int
    updated: int
    skipped: int
    assets: int
    errors: list[str]
