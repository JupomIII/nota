"""SQLite access. One connection per request keeps the server dependency-free."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from ..config import Settings, settings as global_settings

# v2 adds the ``devices`` table: paired devices with a token each, so one can be
# revoked without locking out the others. v3 adds ``device_key``, the app's own
# stable id, so pairing the same iPad twice replaces its token instead of adding
# a second row. The sync envelope is unchanged by either.
SCHEMA_VERSION = 3

SCHEMA = """
CREATE TABLE IF NOT EXISTS objects (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    deleted_at INTEGER,
    seq INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_objects_seq ON objects(seq);
CREATE INDEX IF NOT EXISTS idx_objects_kind ON objects(kind);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    label TEXT NOT NULL,
    local TEXT NOT NULL,
    server TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_files (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    filename TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER,
    device_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(cfg: Settings | None = None) -> sqlite3.Connection:
    config = cfg or global_settings
    config.directory.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.db_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


@contextmanager
def connection(cfg: Settings | None = None) -> Iterator[sqlite3.Connection]:
    conn = connect(cfg)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(cfg: Settings | None = None) -> None:
    with connection(cfg) as conn:
        conn.executescript(SCHEMA)
        # A database created by v2 has the table but not the key: add it in place
        # rather than asking the reader to reset anything.
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(devices)").fetchall()}
        if "device_key" not in columns:
            conn.execute("ALTER TABLE devices ADD COLUMN device_key TEXT")
        # Partial index: devices paired before keys existed keep a NULL key and
        # must not collide with each other.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_key ON devices(device_key) "
            "WHERE device_key IS NOT NULL"
        )
        conn.execute(
            "INSERT OR IGNORE INTO counters(name, value) VALUES('seq', 0)",
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )


def next_seq(conn: sqlite3.Connection) -> int:
    conn.execute("UPDATE counters SET value = value + 1 WHERE name = 'seq'")
    row = conn.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()
    return int(row["value"]) if row else 1


def current_seq(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()
    return int(row["value"]) if row else 0


def row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "kind": row["kind"],
        "id": row["id"],
        "data": json.loads(row["data"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "version": row["version"],
        "deviceId": row["device_id"],
        "deletedAt": row["deleted_at"],
    }
