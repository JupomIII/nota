"""REST surface: sync, assets, backups, diagnostics."""

from __future__ import annotations

import logging
import re
import socket
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import PROTOCOL_VERSION
from .. import discovery
from ..backup import manager as backups
from ..config import MDNS_HOST, settings
from ..database.db import connection
from ..models.schemas import (
    BackupInfo,
    ChangesResponse,
    HealthResponse,
    ImportResult,
    PairDecision,
    PairRequest,
    PairResponse,
    PairStart,
    SessionClaim,
    PushRequest,
    PushResponse,
)
from .. import devices, pair_requests, pair_session, pairing
from ..security import client_address, is_self_client
from ..services import assets as asset_store
from ..sync import engine

router = APIRouter(prefix="/api")
log = logging.getLogger("thoth.pairing")

ASSET_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        ok=True,
        name="nota-server",
        version=PROTOCOL_VERSION,
        deviceName=socket.gethostname(),
        time=int(time.time() * 1000),
        laptopUrl=settings.laptop_app_url,
        serverId=settings.server_id,
        hostname=MDNS_HOST if settings.advertises_mdns else "",
        mdnsUrl=settings.mdns_url,
        mdns=settings.advertises_mdns,
    )


@router.post("/pair", response_model=PairResponse)
def pair(payload: PairRequest, request: Request) -> PairResponse:
    """Exchanges a short-lived code for the pairing token, on the LAN only."""
    client = client_address(request)
    if not pairing.allow_attempt(client):
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Run scripts\\pair.ps1 on the laptop for a new code.",
        )
    if not pairing.verify(settings, payload.code):
        pairing.record_failure(client)
        raise HTTPException(
            status_code=401,
            detail="That pairing code has expired. Run scripts\\pair.ps1 on the laptop for a new one.",
        )
    pairing.reset_failures(client)
    return PairResponse(
        token=settings.read_token(),
        serverUrl=settings.base_url,
        deviceName=socket.gethostname(),
        mdns=settings.advertises_mdns,
    )


def _require_self(request: Request) -> None:
    host = request.client.host if request.client else None
    if not is_self_client(host):
        raise HTTPException(
            status_code=403,
            detail="Pairing details are only available on the laptop itself.",
        )


@router.get("/pair/link")
def pair_link(request: Request) -> dict:
    """Feeds the pairing page on the laptop: code, link and time left."""
    # One QR code, one secret, one five-character confirmation. The page polls
    # this endpoint, so start() keeps the same session until it expires.
    session = pair_session.start()
    _require_self(request)
    return {
        "code": pairing.current_code(settings),
        "confirmCode": session.code,
        "sessionId": session.id,
        "secret": session.secret,
        "link": pair_session.link(settings, session),
        "serverUrl": settings.base_url,
        "setupUrl": settings.setup_url,
        "tunneled": settings.tunneled,
        "expiresIn": pair_session.seconds_left(session),
    }


@router.get("/pair/qr")
def pair_qr(request: Request) -> Response:
    _require_self(request)
    return Response(
        content=pairing.qr_svg(pair_session.link(settings, pair_session.start())),
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/pair/request")
def pair_request_start(payload: PairStart, request: Request) -> dict:
    """The iPad asks to pair; the laptop answers on its pairing page.

    Open to the local network on purpose: any device may knock, and the laptop
    decides. Nothing is handed over here, and a device that knocks too often is
    turned away for a while.
    """
    client = client_address(request)
    if not pair_requests.allow_create(client):
        # Say when, not just "later": the refusal covers a sliding ten-minute
        # window, so a made-up "wait a minute" was wrong by a factor of ten.
        seconds = pair_requests.retry_after(client)
        raise HTTPException(
            status_code=429,
            detail=f"Too many pairing requests from this device. Try again in {seconds} seconds.",
            headers={"Retry-After": str(seconds)},
        )
    ask = pair_requests.create(payload.device, client, payload.deviceKey)
    log.info("Pairing requested by %s (%s)", ask.label, ask.address)
    return {"id": ask.id, "expiresIn": int(pair_requests.REQUEST_TTL)}


@router.get("/pair/requests")
def pair_request_list(request: Request) -> dict:
    """Feeds the waiting list on the laptop's pairing page."""
    _require_self(request)
    return {
        "requests": [
            {
                "id": ask.id,
                "device": ask.label,
                "address": ask.address,
                "ageSeconds": max(0, int(time.time() - ask.created)),
            }
            for ask in pair_requests.open_asks()
        ],
        "expiresIn": pairing.seconds_left(settings),
    }


@router.post("/pair/requests/{request_id}")
def pair_request_decide(request_id: str, payload: PairDecision, request: Request) -> dict:
    """Allow or refuse one waiting device. Only the laptop itself may answer."""
    _require_self(request)
    ask = pair_requests.decide(request_id, payload.allow)
    if ask is None:
        raise HTTPException(status_code=404, detail="That request is no longer waiting.")
    log.info("Pairing %s for %s (%s)", ask.state, ask.label, ask.address)
    return {"state": ask.state}


@router.get("/pair/request/{request_id}")
def pair_request_poll(request_id: str) -> dict:
    """The answer, for the device that asked.

    The id is the only credential: it is unguessable, expires in five minutes,
    and the token inside is handed over exactly once.
    """
    ask, handover = pair_requests.claim(request_id)
    if ask is None:
        return JSONResponse(
            {"detail": "That pairing request has expired. Ask again from the iPad."},
            status_code=404,
        )
    if not handover:
        return {"state": ask.state}
    # The laptop reaches itself over loopback, where plain HTTP is a secure
    # context. Handing it the LAN https address would ask the laptop to trust
    # the certificate that only the iPad installs, so it gets its own door.
    server_url = settings.laptop_app_url if is_self_client(ask.address) else settings.base_url
    # Approval is the primary pairing path, so it mints a token of its own: a
    # device paired here is revocable like one paired by QR, and the master
    # token stays on the laptop that already holds it.
    _, token = devices.register(ask.label, ask.address, ask.device_key)
    log.info("Paired a device the laptop approved")
    return {
        "state": "allowed",
        "token": token,
        "serverUrl": server_url,
        "deviceName": socket.gethostname(),
        "mdns": settings.advertises_mdns,
    }


@router.post("/pair/session", response_model=PairResponse)
def pair_session_claim(payload: SessionClaim, request: Request) -> PairResponse:
    """A device proves it scanned the QR code, without sending the secret.

    What arrives is an HMAC of the session id keyed by that secret: enough to
    prove knowledge of it, useless if it leaks afterwards, and useless for the
    next QR code. The device gets a token of its own, so revoking it later
    leaves every other device working.
    """
    client = client_address(request)
    state, session = pair_session.claim(payload.id, payload.proof)
    if state == "refused":
        left = max(0, pair_session.MAX_ATTEMPTS - (session.attempts if session else 0))
        raise HTTPException(
            status_code=401,
            detail=(
                "That pairing code did not match. "
                f"{left} attempt{'s' if left != 1 else ''} left before the laptop needs a new QR code."
            ),
        )
    if state == "locked":
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Open the pairing page on the laptop and scan the new QR code.",
        )
    if state == "expired":
        raise HTTPException(
            status_code=410,
            detail="That pairing code has expired. Open the pairing page on the laptop and scan the new QR code.",
        )
    if state == "used":
        raise HTTPException(
            status_code=409,
            detail="That QR code has already paired a device. Open the pairing page for a new one.",
        )
    if state != "ok" or session is None:
        raise HTTPException(
            status_code=401,
            detail="That pairing code is not one this laptop issued.",
        )
    _, token = devices.register(
        payload.deviceName.strip() or "A device", client, payload.deviceKey
    )
    # Never the secret, the proof or the token: a log is not a key store.
    log.info("Paired a device on the local network")
    # The laptop reaches itself over loopback, where plain HTTP is a secure
    # context; the iPad gets back the LAN HTTPS address it just used.
    server_url = settings.laptop_app_url if is_self_client(client) else settings.base_url
    return PairResponse(
        token=token,
        serverUrl=server_url,
        deviceName=socket.gethostname(),
        mdns=settings.advertises_mdns,
        code=session.code,
    )


@router.get("/devices")
def list_devices(request: Request) -> dict:
    """Which devices are paired, so the laptop can revoke one by name."""
    _require_self(request)
    return {"devices": devices.listing()}


@router.post("/devices/{device_id}/revoke")
def revoke_device(device_id: str, request: Request) -> dict:
    """Takes one device's token away. The others keep syncing."""
    _require_self(request)
    if not devices.revoke(device_id):
        raise HTTPException(status_code=404, detail="That device is not paired any more.")
    log.info("Revoked one paired device")
    return {"ok": True}


@router.get("/status")
def status() -> dict:
    with connection() as conn:
        counts = {
            row["kind"]: int(row["total"])
            for row in conn.execute(
                "SELECT kind, COUNT(*) AS total FROM objects "
                "WHERE deleted_at IS NULL GROUP BY kind"
            ).fetchall()
        }
        conflicts = conn.execute("SELECT COUNT(*) AS total FROM conflicts").fetchone()["total"]
        cursor = conn.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()["value"]
        devices = [
            row["device_id"]
            for row in conn.execute(
                "SELECT DISTINCT device_id FROM objects WHERE device_id != ''"
            ).fetchall()
        ]
    return {
        "deviceName": socket.gethostname(),
        "serverId": settings.server_id,
        "hostname": MDNS_HOST if settings.advertises_mdns else "",
        "counts": counts,
        "conflicts": int(conflicts),
        "cursor": int(cursor),
        "devices": devices,
        "dataDir": str(settings.directory),
        "tls": settings.tls,
        "tunneled": settings.tunneled,
        "mdns": settings.advertises_mdns,
        "baseUrl": settings.base_url,
        "laptopUrl": settings.laptop_app_url,
        "mdnsUrl": settings.mdns_url,
        "discovery": discovery.describe(),
    }


@router.post("/sync/push", response_model=PushResponse)
def sync_push(payload: PushRequest) -> PushResponse:
    with connection() as conn:
        accepted, conflicts, cursor = engine.push(conn, payload.records)
    return PushResponse(
        accepted=accepted,
        conflicts=conflicts,
        cursor=cursor,
        serverTime=int(time.time() * 1000),
    )


@router.get("/sync/changes", response_model=ChangesResponse)
def sync_changes(since: int = 0, limit: int = 400) -> ChangesResponse:
    if since < 0:
        raise HTTPException(status_code=400, detail="since must be >= 0")
    with connection() as conn:
        records, cursor, has_more = engine.changes(conn, since, limit)
    return ChangesResponse(records=records, cursor=cursor, hasMore=has_more)


@router.put("/sync/assets/{asset_id}")
async def upload_asset(asset_id: str, request: Request) -> dict:
    if not ASSET_ID.match(asset_id):
        raise HTTPException(status_code=400, detail="invalid asset id")
    payload = await request.body()
    if len(payload) == 0:
        raise HTTPException(status_code=400, detail="empty asset")
    if len(payload) > settings.max_asset_bytes:
        raise HTTPException(status_code=413, detail="asset too large")
    mime = request.headers.get("content-type", "application/octet-stream")
    filename = request.headers.get("x-asset-name", "")
    with connection() as conn:
        meta = asset_store.save_asset(conn, asset_id, payload, mime, filename)
    return {"ok": True, **meta}


@router.get("/sync/assets/{asset_id}")
def download_asset(asset_id: str) -> FileResponse:
    if not ASSET_ID.match(asset_id):
        raise HTTPException(status_code=400, detail="invalid asset id")
    with connection() as conn:
        meta = asset_store.asset_metadata(conn, asset_id)
    path = asset_store.blob_path(asset_id)
    if meta is None or not path.exists():
        raise HTTPException(status_code=404, detail="asset not found")
    return FileResponse(
        path,
        media_type=str(meta["mime"]),
        filename=str(meta["filename"] or path.name),
    )


@router.post("/backup/create", response_model=BackupInfo)
def create_backup() -> BackupInfo:
    info = backups.create_backup(reason="api")
    return BackupInfo(name=info["name"], size=info["size"], createdAt=info["createdAt"])


@router.get("/backup/list", response_model=list[BackupInfo])
def list_backups() -> list[BackupInfo]:
    return [BackupInfo(**entry) for entry in backups.list_backups()]


@router.get("/backup/export")
def export_backup() -> Response:
    payload = backups.export_bytes()
    stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="thoth-{stamp}.zip"',
            "Content-Length": str(len(payload)),
        },
    )


@router.post("/backup/import", response_model=ImportResult)
async def import_backup(request: Request) -> ImportResult:
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="empty backup upload")
    result = backups.import_bytes(payload=payload)
    return ImportResult(**result)


@router.get("/backup/download/{name}")
def download_backup(name: str) -> FileResponse:
    path: Path | None = backups.backup_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail="backup not found")
    return FileResponse(path, media_type="application/zip", filename=name)


@router.get("/conflicts")
def list_conflicts(limit: int = 200) -> dict:
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, kind, object_id, label, created_at FROM conflicts ORDER BY id DESC LIMIT ?",
            (max(1, min(1000, limit)),),
        ).fetchall()
    return {
        "conflicts": [
            {
                "id": row["id"],
                "kind": row["kind"],
                "objectId": row["object_id"],
                "label": row["label"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]
    }


@router.get("/")
def api_root() -> JSONResponse:
    return JSONResponse(
        {
            "name": "nota-server",
            "protocol": PROTOCOL_VERSION,
            "docs": "/docs",
            "app": settings.base_url,
        }
    )
