"""Reset driver.

The reset is NOT a Pi GPIO pin — the Raspberry Pi commands the Siemens LOGO!
8.3 over Modbus TCP by setting a marker coil. The LOGO! program then drives the
Phoenix Contact PLC-REL-24DC/21 relay with a timed pulse (the industrial PLC
owns the pulse timing, which is the reliable part). Off-Pi we use a mock.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger("reset")


class ResetDriver:
    def pulse(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class MockReset(ResetDriver):
    def __init__(self, coil: int, hold_sec: float):
        self.coil = coil
        self.hold_sec = hold_sec

    def pulse(self) -> None:
        log.info("[MOCK] set LOGO! reset coil %s for %.2fs", self.coil, self.hold_sec)


class LogoReset(ResetDriver):
    """Sets the LOGO! reset marker coil, holds briefly, then clears it."""

    def __init__(self, host: str, port: int, unit_id: int, coil: int, hold_sec: float):
        from pymodbus.client import ModbusTcpClient  # lazy import

        self._client = ModbusTcpClient(host, port=port)
        self._unit = unit_id
        self._coil = coil
        self._hold = hold_sec

    def pulse(self) -> None:
        self._client.write_coil(self._coil, True, slave=self._unit)
        time.sleep(self._hold)
        self._client.write_coil(self._coil, False, slave=self._unit)
        log.info("LOGO! reset coil %s pulsed", self._coil)


def make_reset(mode: str, logo: dict, coil: int, hold_sec: float) -> ResetDriver:
    if mode == "real":
        try:
            return LogoReset(logo["host"], logo["port"], logo["unit_id"], coil, hold_sec)
        except Exception as e:
            log.warning("falling back to MockReset: %s", e)
    return MockReset(coil, hold_sec)
