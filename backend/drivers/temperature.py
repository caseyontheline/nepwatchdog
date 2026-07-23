"""Temperature-controller drivers.

The rest of the app only talks to `TemperatureDriver`. In real mode we read the
two zone temperatures from the **Siemens LOGO! 8.3** over Modbus TCP (the LOGO!
digitizes the isolated 4-20mA/0-10V signals from the Heatec controllers). Off-Pi
we use `MockDriver`, which produces realistic-looking readings.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, asdict
from typing import List


@dataclass
class Reading:
    controller_id: str
    temp_f: float
    setpoint_f: float
    online: bool
    ts: float  # epoch seconds

    def to_dict(self) -> dict:
        d = asdict(self)
        d["temp_f"] = round(self.temp_f, 1)
        d["setpoint_f"] = round(self.setpoint_f, 1)
        return d


class TemperatureDriver:
    """Interface all drivers implement."""

    def read(self, controller_id: str) -> Reading:  # pragma: no cover - interface
        raise NotImplementedError


class MockDriver(TemperatureDriver):
    """Simulates two controllers holding near a setpoint with gentle drift."""

    def __init__(self, controllers: List[dict], setpoint_f: float):
        self._sp = setpoint_f
        self._state = {c["id"]: setpoint_f - 5 + random.uniform(-5, 5) for c in controllers}
        self._t0 = time.time()

    def read(self, controller_id: str) -> Reading:
        elapsed = time.time() - self._t0
        wobble = 8.0 * math.sin(elapsed / 20.0 + hash(controller_id) % 7)
        cur = self._state[controller_id]
        cur += (self._sp - cur) * 0.05 + random.uniform(-1.5, 1.5)
        self._state[controller_id] = cur
        return Reading(controller_id, cur + wobble, self._sp, True, time.time())


class LogoDriver(TemperatureDriver):
    """Reads zone temperatures from the Siemens LOGO! 8.3 over Modbus TCP.

    Each controller maps to a LOGO! holding register (VW) carrying the digitized
    analog value; `scale`/`offset` convert the raw LOGO! integer to degrees F
    (set these in config to match your LOGO! program's analog handling).
    """

    def __init__(self, controllers: List[dict], setpoint_f: float, host: str, port: int, unit_id: int):
        from pymodbus.client import ModbusTcpClient  # lazy import

        self._client = ModbusTcpClient(host, port=port)
        self._unit = unit_id
        self._sp = setpoint_f
        self._map = {c["id"]: c for c in controllers}

    def read(self, controller_id: str) -> Reading:
        cfg = self._map[controller_id]
        try:
            rr = self._client.read_holding_registers(cfg["reg"], count=1, slave=self._unit)
            online = not rr.isError()
            raw = rr.registers[0] if online else 0
            temp = raw * cfg["scale"] + cfg["offset"] if online else 0.0
        except Exception:
            temp, online = 0.0, False
        return Reading(controller_id, temp, self._sp, online, time.time())


def make_driver(mode: str, controllers: List[dict], setpoint_f: float, logo: dict) -> TemperatureDriver:
    if mode == "real":
        try:
            return LogoDriver(controllers, setpoint_f, logo["host"], logo["port"], logo["unit_id"])
        except Exception:
            pass  # pymodbus missing / not reachable -> fall back to mock
    return MockDriver(controllers, setpoint_f)
