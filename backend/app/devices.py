"""Paired devices, each with its own token.

The laptop used to hand every client the same long-lived token, which made
"revoke that iPad" impossible without locking out every device. Each successful
pairing now mints a token of its own, stored as a SHA-256 hash, and revoking one
device leaves the others working.

The middleware asks :func:`token_valid` on every API request, so the lookup is a
dict hit kept in memory and refreshed whenever the table changes.
"""

from __future__ import annotations

import hashlib
import secrets
import time

from .database.db import connection

# token hash -> device id, for devices that are not revoked.
_tokens: dict[str, str] = {}
# token hash -> device id, for devices that were revoked. Kept apart so the
# server can say *why* a token was refused instead of "invalid".
_revoked: dict[str, str] = {}
_loaded = False


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _reload() -> None:
    global _loaded
    with connection() as conn:
        rows = conn.execute("SELECT id, token_hash, revoked_at FROM devices").fetchall()
    _tokens.clear()
    _revoked.clear()
    for row in rows:
        target = _revoked if row["revoked_at"] is not None else _tokens
        target[str(row["token_hash"])] = str(row["id"])
    _loaded = True


def _ensure_loaded() -> dict[str, str]:
    if not _loaded:
        _reload()
    return _tokens


def register(label: str, address: str, key: str = "") -> tuple[str, str]:
    """Mints a token for one device; the token itself is returned only here.

    Pairing the same device again *replaces* its token instead of adding a
    second row. ``key`` is the app's own stable id and is the surest match; an
    older copy sends no key, so the same label on the same address counts as
    the same device asking again. In both cases any other live row for that
    device loses its token at the same moment — a device can never hold two
    working tokens, which is what used to make an old pairing valid forever.
    """
    token = secrets.token_urlsafe(32)
    moment = int(time.time() * 1000)
    # NULL rather than "": SQLite never matches NULL, so "this app sent no key"
    # is expressed by the queries themselves instead of a guard around them.
    identifier = (key or "").strip()[:128] or None
    name = label[:120] or "A device"
    origin = address or ""
    with connection() as conn:
        # The id it announces, or else the label and address it came from.
        match = conn.execute(
            "SELECT id FROM devices WHERE device_key = ?", (identifier,)
        ).fetchone() or conn.execute(
            "SELECT id FROM devices WHERE label = ? AND address = ? "
            "ORDER BY last_seen_at DESC LIMIT 1",
            (name, origin),
        ).fetchone()
        if match is None:
            device_id = secrets.token_hex(8)
            conn.execute(
                "INSERT INTO devices "
                "(id, label, address, token_hash, created_at, last_seen_at, device_key) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (device_id, name, origin, _hash(token), moment, moment, identifier),
            )
        else:
            device_id = str(match["id"])
            conn.execute(
                "UPDATE devices SET label = ?, address = ?, token_hash = ?, "
                "device_key = COALESCE(?, device_key), last_seen_at = ?, revoked_at = NULL "
                "WHERE id = ?",
                (name, origin, _hash(token), identifier, moment, device_id),
            )
            # Rows stacked by earlier pairings are live and still accepted:
            # they are the same device, so they go now.
            conn.execute(
                "UPDATE devices SET revoked_at = ? WHERE id <> ? AND revoked_at IS NULL "
                "AND (device_key = ? OR (label = ? AND address = ?))",
                (moment, device_id, identifier, name, origin),
            )
    _reload()
    return device_id, token


def refresh() -> None:
    """Re-reads the table after something other than this module changed it."""
    _reload()


def token_valid(token: str) -> bool:
    """True when this token belongs to a device that is still allowed in."""
    provided = (token or "").strip()
    if not provided:
        return False
    digest = _hash(provided)
    for known in _ensure_loaded():
        # Constant-time even though the table is short: the habit matters more
        # than the microseconds, and it documents that this is a secret compare.
        if secrets.compare_digest(known, digest):
            return True
    return False


def lookup(token: str) -> str:
    """``active``, ``revoked`` or ``unknown`` — for a sentence, not a decision."""
    provided = (token or "").strip()
    if not provided:
        return "unknown"
    digest = _hash(provided)
    _ensure_loaded()
    if any(secrets.compare_digest(known, digest) for known in _tokens):
        return "active"
    if any(secrets.compare_digest(known, digest) for known in _revoked):
        return "revoked"
    return "unknown"


def listing() -> list[dict]:
    _ensure_loaded()
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, label, address, created_at, last_seen_at, revoked_at "
            "FROM devices ORDER BY created_at DESC"
        ).fetchall()
    return [
        {
            "id": row["id"],
            "label": row["label"],
            "address": row["address"],
            "createdAt": int(row["created_at"]),
            "lastSeenAt": int(row["last_seen_at"]),
            "revoked": row["revoked_at"] is not None,
        }
        for row in rows
    ]


def revoke(device_id: str) -> bool:
    """Takes one device's token away. Everything else keeps working."""
    moment = int(time.time() * 1000)
    with connection() as conn:
        changed = conn.execute(
            "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (moment, device_id),
        ).rowcount
    _reload()
    return bool(changed)


def reset() -> None:
    """Testing hook: forget every device and every token."""
    global _loaded
    with connection() as conn:
        conn.execute("DELETE FROM devices")
    _tokens.clear()
    _revoked.clear()
    _loaded = False
