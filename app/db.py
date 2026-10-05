"""SQLite storage. One small file in the data volume, no ORM."""
import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS datacenters (
    id       INTEGER PRIMARY KEY,
    code     TEXT NOT NULL UNIQUE,
    name     TEXT NOT NULL,
    address  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS hmcs (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    host          TEXT NOT NULL,
    port          INTEGER NOT NULL DEFAULT 12443,
    dc_id         INTEGER NOT NULL REFERENCES datacenters(id),
    username      TEXT NOT NULL,
    password_enc  TEXT NOT NULL,
    tls_mode      TEXT NOT NULL DEFAULT 'verify',   -- verify | ca | none
    ca_pem        TEXT NOT NULL DEFAULT '',
    interval_min  INTEGER NOT NULL DEFAULT 15,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS snapshots (
    hmc_id        INTEGER PRIMARY KEY REFERENCES hmcs(id) ON DELETE CASCADE,
    status        TEXT NOT NULL,              -- ok | warn | err
    error         TEXT,
    attempted_at  TEXT,                       -- last poll attempt, UTC ISO
    polled_at     TEXT,                       -- last successful poll, UTC ISO
    duration_s    REAL,
    data          TEXT                        -- JSON from the last successful poll
);
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    login       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'local',  -- local | ad
    role        TEXT NOT NULL DEFAULT 'viewer', -- admin | viewer
    role_locked INTEGER NOT NULL DEFAULT 0,     -- AD user: keep role set by admin
    pw_hash     TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    via_group   TEXT NOT NULL DEFAULT '',
    last_login  TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class DB:
    def __init__(self, path: Path | str):
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        if str(path) != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)

    def all(self, sql: str, *args: Any) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql: str, *args: Any) -> dict | None:
        with self._lock:
            r = self.conn.execute(sql, args).fetchone()
            return dict(r) if r else None

    def run(self, sql: str, *args: Any) -> int:
        with self._lock:
            cur = self.conn.execute(sql, args)
            return cur.lastrowid

    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.one("SELECT value FROM settings WHERE key=?", key)
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        self.run(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            key, json.dumps(value, ensure_ascii=False),
        )
