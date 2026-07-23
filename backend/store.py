"""SQLite persistence for temperature history and alerts.

SQLite keeps this dependency-free and survives Pi reboots without running a
separate database service. Writes happen from the poll loop; the API reads for
charts and the alert feed. A background prune keeps the DB small.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import List, Optional

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None
_retention_days = 30


def init(db_path: str, retention_days: int = 30) -> None:
    global _conn, _retention_days
    _retention_days = retention_days
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(db_path, check_same_thread=False)
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS readings (
            ts REAL NOT NULL,
            zone TEXT NOT NULL,
            temp_f REAL,
            online INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
        CREATE TABLE IF NOT EXISTS alerts (
            ts REAL NOT NULL,
            zone TEXT,
            severity TEXT NOT NULL,
            kind TEXT NOT NULL,
            message TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
        """
    )
    _conn.commit()


def record_readings(controllers: List[dict], ts: float) -> None:
    with _lock:
        _conn.executemany(
            "INSERT INTO readings (ts, zone, temp_f, online) VALUES (?,?,?,?)",
            [(ts, c["controller_id"], c["temp_f"], int(c["online"])) for c in controllers],
        )
        _conn.commit()


def record_alert(alert: dict) -> None:
    with _lock:
        _conn.execute(
            "INSERT INTO alerts (ts, zone, severity, kind, message) VALUES (?,?,?,?,?)",
            (alert["ts"], alert.get("zone"), alert["severity"], alert["kind"], alert["message"]),
        )
        _conn.commit()


def history(hours: float, max_points: int = 600) -> dict:
    """Return per-zone time series for the last `hours`, downsampled to fit.

    Downsampling uses a time bucket so the chart stays light even over long
    windows (a Pi logging every 2s produces a lot of rows).
    """
    since = time.time() - hours * 3600
    bucket = max(1.0, (hours * 3600) / max_points)
    with _lock:
        rows = _conn.execute(
            """
            SELECT zone,
                   CAST(ts / ? AS INT) * ? AS bucket_ts,
                   AVG(temp_f) AS temp_f,
                   MIN(online) AS online
            FROM readings
            WHERE ts >= ?
            GROUP BY zone, bucket_ts
            ORDER BY bucket_ts
            """,
            (bucket, bucket, since),
        ).fetchall()
    series: dict = {}
    for zone, bts, temp, online in rows:
        series.setdefault(zone, []).append(
            {"ts": bts, "temp_f": round(temp, 1) if temp is not None else None, "online": bool(online)}
        )
    return series


def recent_alerts(limit: int = 50) -> List[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT ts, zone, severity, kind, message FROM alerts ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {"ts": r[0], "zone": r[1], "severity": r[2], "kind": r[3], "message": r[4]}
        for r in rows
    ]


def prune() -> None:
    cutoff = time.time() - _retention_days * 86400
    with _lock:
        _conn.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
        _conn.execute("DELETE FROM alerts WHERE ts < ?", (cutoff,))
        _conn.commit()
