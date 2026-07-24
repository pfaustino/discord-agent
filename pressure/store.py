"""Persistence adapter: full engine state survives restarts.

SQLite implementation with a schema version. The live bot's database is
intentionally NOT reused — this is an isolated, test-only system; a clean
adapter keeps it that way. Use ":memory:" for throwaway runs.
"""
from __future__ import annotations

import json
import sqlite3
import threading

from .models import Contribution, Decision, Signal

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signals (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL, weight REAL NOT NULL, confidence REAL NOT NULL,
    ts REAL NOT NULL, topic TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    decay TEXT NOT NULL, decay_rate REAL NOT NULL, max_lifetime REAL NOT NULL,
    state TEXT NOT NULL, resolved_reason TEXT NOT NULL DEFAULT '',
    resolved_ts REAL
);
CREATE TABLE IF NOT EXISTS buckets (
    name TEXT PRIMARY KEY, pressure REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (
    scope TEXT PRIMARY KEY, until REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL, topic TEXT NOT NULL, bucket TEXT NOT NULL,
    content_key TEXT NOT NULL, summary TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL, allowed INTEGER NOT NULL, reasons TEXT NOT NULL,
    proposal_topic TEXT NOT NULL, proposal_bucket TEXT NOT NULL,
    proposal_summary TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
    pressures TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
);
"""


class SqliteStore:
    def __init__(self, path: str = ":memory:"):
        self.path = path
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()  # single-writer guard (atomic updates)
        with self._lock, self._conn:
            self._conn.executescript(SCHEMA)
            cur = self._conn.execute("SELECT value FROM meta WHERE key='schema_version'")
            row = cur.fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),))
            elif int(row["value"]) != SCHEMA_VERSION:
                raise RuntimeError(
                    f"pressure store schema {row['value']} != supported {SCHEMA_VERSION}")

    # -- signals ------------------------------------------------------------

    def upsert_signal(self, s: Signal) -> None:
        row = s.to_row()
        cols = ", ".join(row)
        placeholders = ", ".join("?" for _ in row)
        updates = ", ".join(f"{c}=excluded.{c}" for c in row if c != "key")
        with self._lock, self._conn:
            self._conn.execute(
                f"INSERT INTO signals ({cols}) VALUES ({placeholders}) "
                f"ON CONFLICT (key) DO UPDATE SET {updates}",
                tuple(row.values()))

    def get_signal(self, key: str) -> Signal | None:
        cur = self._conn.execute("SELECT * FROM signals WHERE key = ?", (key,))
        row = cur.fetchone()
        return Signal(**dict(row)) if row else None

    def signals(self, state: str | None = "active") -> list[Signal]:
        q = "SELECT * FROM signals"
        args: tuple = ()
        if state:
            q += " WHERE state = ?"
            args = (state,)
        return [Signal(**dict(r)) for r in self._conn.execute(q, args)]

    def delete_signal(self, key: str) -> None:
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM signals WHERE key = ?", (key,))

    # -- buckets ------------------------------------------------------------

    def get_pressures(self) -> dict[str, float]:
        return {r["name"]: r["pressure"] for r in self._conn.execute("SELECT * FROM buckets")}

    def set_pressures(self, pressures: dict[str, float]) -> None:
        with self._lock, self._conn:
            for name, value in pressures.items():
                self._conn.execute(
                    "INSERT INTO buckets (name, pressure) VALUES (?, ?) "
                    "ON CONFLICT (name) DO UPDATE SET pressure = excluded.pressure",
                    (name, value))

    # -- cooldowns ----------------------------------------------------------

    def get_cooldowns(self) -> dict[str, float]:
        return {r["scope"]: r["until"] for r in self._conn.execute("SELECT * FROM cooldowns")}

    def set_cooldown(self, scope: str, until: float) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO cooldowns (scope, until) VALUES (?, ?) "
                "ON CONFLICT (scope) DO UPDATE SET until = excluded.until",
                (scope, until))

    # -- contributions & decisions ------------------------------------------

    def add_contribution(self, c: Contribution, keep: int) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO contributions (ts, topic, bucket, content_key, summary, channel_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (c.ts, c.topic, c.bucket, c.content_key, c.summary, c.channel_id))
            self._conn.execute(
                "DELETE FROM contributions WHERE id <= "
                "(SELECT MAX(id) FROM contributions) - ?", (keep,))

    def contributions(self) -> list[Contribution]:
        rows = self._conn.execute(
            "SELECT ts, topic, bucket, content_key, summary, channel_id "
            "FROM contributions ORDER BY id")
        return [Contribution(**dict(r)) for r in rows]

    def add_decision(self, d: Decision, keep: int) -> None:
        row = d.to_row()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO decisions (ts, allowed, reasons, proposal_topic, proposal_bucket, "
                "proposal_summary, channel_id, pressures) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (row["ts"], int(row["allowed"]), row["reasons"], row["proposal_topic"],
                 row["proposal_bucket"], row["proposal_summary"], row["channel_id"],
                 row["pressures"]))
            self._conn.execute(
                "DELETE FROM decisions WHERE id <= (SELECT MAX(id) FROM decisions) - ?",
                (keep,))

    def decisions(self) -> list[dict]:
        out = []
        for r in self._conn.execute("SELECT * FROM decisions ORDER BY id"):
            d = dict(r)
            d["reasons"] = json.loads(d["reasons"])
            d["pressures"] = json.loads(d["pressures"])
            d["allowed"] = bool(d["allowed"])
            out.append(d)
        return out

    # -- misc kv (topic last-seen, energy, message times) -------------------

    def kv_get(self, key: str, default=None):
        cur = self._conn.execute("SELECT value FROM kv WHERE key = ?", (key,))
        row = cur.fetchone()
        return json.loads(row["value"]) if row else default

    def kv_set(self, key: str, value) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO kv (key, value) VALUES (?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)))

    def close(self) -> None:
        self._conn.close()
