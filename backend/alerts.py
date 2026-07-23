"""Alert engine + notifier.

Watches the live snapshot and emits an alert only on a *state change* (edge),
never on every poll, so a heater sitting in "warn" doesn't spam. Tracks:
  - temperature severity per zone: ok -> warn -> critical (and recovery)
  - controller online/offline
  - weather-blocked reset attempts (raised by the API, not here)

Notifications are pluggable: a log notifier always runs; an optional email
notifier uses Resend (stdlib HTTP, no dependency).
"""
from __future__ import annotations

import logging
import time
from typing import Callable, Dict, List, Optional

log = logging.getLogger("alerts")

# Severity ordering for comparisons.
_RANK = {"ok": 0, "warn": 1, "critical": 2, "offline": 3}


class AlertEngine:
    def __init__(self, on_alert: Callable[[dict], None]):
        self._on_alert = on_alert
        self._prev_status: Dict[str, str] = {}

    def evaluate(self, controllers: List[dict]) -> List[dict]:
        """Diff current statuses against the last poll; emit edge alerts."""
        out = []
        for c in controllers:
            zone = c["controller_id"]
            name = c.get("name", zone)
            cur = c["status"]  # ok | warn | critical | offline
            prev = self._prev_status.get(zone)
            self._prev_status[zone] = cur
            if prev is None or prev == cur:
                continue
            alert = self._make(zone, name, prev, cur, c.get("temp_f"))
            if alert:
                out.append(alert)
                self._on_alert(alert)
        return out

    def _make(self, zone, name, prev, cur, temp) -> Optional[dict]:
        now = time.time()
        if cur == "offline":
            return _a(now, zone, "critical", "offline", f"{name} went OFFLINE (no signal)")
        if prev == "offline":
            return _a(now, zone, "info", "recovery", f"{name} back online")
        if _RANK[cur] > _RANK[prev]:  # escalation
            sev = "critical" if cur == "critical" else "warning"
            return _a(now, zone, sev, cur, f"{name} entered {cur.upper()} at {temp:.0f}°F")
        if _RANK[cur] < _RANK[prev]:  # recovery / de-escalation
            return _a(now, zone, "info", "recovery", f"{name} cooled to {cur.upper()} ({temp:.0f}°F)")
        return None


def _a(ts, zone, severity, kind, message) -> dict:
    return {"ts": ts, "zone": zone, "severity": severity, "kind": kind, "message": message}


# --- Notifiers -------------------------------------------------------------
def log_notifier(alert: dict) -> None:
    lvl = logging.ERROR if alert["severity"] == "critical" else logging.WARNING
    log.log(lvl, "ALERT [%s] %s", alert["severity"].upper(), alert["message"])


class ResendEmailNotifier:
    """Sends critical/warning alerts by email via Resend (https://resend.com).

    Only fires for warning+ to avoid noise on recoveries. No dependency — posts
    JSON with urllib.
    """

    def __init__(self, api_key: str, sender: str, recipients: List[str], min_severity: str = "warning"):
        self._key = api_key
        self._from = sender
        self._to = recipients
        self._min = _RANK.get(min_severity if min_severity != "warning" else "warn", 1)

    def __call__(self, alert: dict) -> None:
        sev = alert["severity"]
        rank = 2 if sev == "critical" else 1 if sev == "warning" else 0
        if rank < self._min:
            return
        import json
        import urllib.request

        body = json.dumps(
            {
                "from": self._from,
                "to": self._to,
                "subject": f"[Heater Watchdog] {sev.upper()}: {alert['message']}",
                "text": f"{alert['message']}\n\nSeverity: {sev}\nTime: {time.ctime(alert['ts'])}",
            }
        ).encode()
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=body,
            headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=8)
            log.info("alert email sent: %s", alert["message"])
        except Exception as e:
            log.warning("alert email failed: %s", e)


def build_notifier(cfg) -> Callable[[dict], None]:
    """Compose the log notifier with an optional email notifier."""
    notifiers: List[Callable[[dict], None]] = [log_notifier]
    if cfg.RESEND_API_KEY and cfg.ALERT_EMAIL_TO:
        notifiers.append(
            ResendEmailNotifier(
                cfg.RESEND_API_KEY,
                cfg.ALERT_EMAIL_FROM,
                [e.strip() for e in cfg.ALERT_EMAIL_TO.split(",") if e.strip()],
                cfg.ALERT_EMAIL_MIN_SEVERITY,
            )
        )

    def fan_out(alert: dict) -> None:
        for n in notifiers:
            try:
                n(alert)
            except Exception as e:  # never let a notifier break the poll loop
                log.warning("notifier error: %s", e)

    return fan_out
