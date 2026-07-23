"""Weather driver (Ambient Weather WS-2902).

Informational readout shown in the dashboard header (wind + rain). It no longer
gates the heater reset — reset is allowed regardless of conditions.

Real mode polls the Ambient Weather cloud API (the WS-2902 console uploads to
ambientweather.net). If keys are missing it falls back to the mock (fair
weather), so the app stays usable.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

log = logging.getLogger("weather")


@dataclass
class Weather:
    wind_mph: float
    raining: bool
    online: bool
    ts: float

    def to_dict(self) -> dict:
        return {
            "wind_mph": round(self.wind_mph, 1),
            "raining": self.raining,
            "online": self.online,
            "ts": self.ts,
        }


class WeatherDriver:
    def read(self) -> Weather:  # pragma: no cover - interface
        raise NotImplementedError


class MockWeather(WeatherDriver):
    def read(self) -> Weather:
        return Weather(wind_mph=6.0, raining=False, online=True, ts=time.time())


class AmbientWeather(WeatherDriver):
    """Polls ambientweather.net for the first station on the account."""

    URL = "https://rt.ambientweather.net/v1/devices"

    def __init__(self, api_key: str, app_key: str):
        self._api_key = api_key
        self._app_key = app_key

    def read(self) -> Weather:
        import urllib.request
        import json

        try:
            url = f"{self.URL}?apiKey={self._api_key}&applicationKey={self._app_key}"
            with urllib.request.urlopen(url, timeout=8) as resp:
                data = json.load(resp)
            last = data[0]["lastData"]
            wind = float(last.get("windspeedmph", 0.0))
            # hourlyrainin > 0 (or nonzero rain rate) => currently raining.
            raining = float(last.get("hourlyrainin", 0.0)) > 0.0
            return Weather(wind, raining, True, time.time())
        except Exception as e:
            log.warning("weather fetch failed: %s", e)
            return Weather(0.0, False, False, time.time())


def make_weather(mode: str, api_key: str, app_key: str) -> WeatherDriver:
    if mode == "real" and api_key and app_key:
        return AmbientWeather(api_key, app_key)
    return MockWeather()
