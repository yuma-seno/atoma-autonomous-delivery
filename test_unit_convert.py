"""Tests for unit conversion (temperature and length)."""

import subprocess
import sys
from pathlib import Path

import pytest

from unit_convert.temperature import convert_temperature
from unit_convert.length import convert_length

# ---------------------------------------------------------------------------
# Temperature conversion tests
# ---------------------------------------------------------------------------


class TestTemperatureConversion:
    def test_celsius_to_fahrenheit(self):
        assert convert_temperature(0, "C", "F") == 32.0

    def test_celsius_to_fahrenheit_100(self):
        assert convert_temperature(100, "C", "F") == 212.0

    def test_celsius_to_fahrenheit_negative_40(self):
        assert convert_temperature(-40, "C", "F") == -40.0

    def test_fahrenheit_to_celsius(self):
        assert convert_temperature(32, "F", "C") == 0.0

    def test_fahrenheit_to_celsius_212(self):
        assert convert_temperature(212, "F", "C") == 100.0

    def test_celsius_to_kelvin(self):
        assert convert_temperature(0, "C", "K") == 273.15

    def test_celsius_to_kelvin_absolute_zero(self):
        assert convert_temperature(-273.15, "C", "K") == 0.0

    def test_kelvin_to_celsius(self):
        assert convert_temperature(273.15, "K", "C") == 0.0

    def test_kelvin_to_celsius_absolute_zero(self):
        assert convert_temperature(0, "K", "C") == -273.15

    def test_fahrenheit_to_kelvin(self):
        result = convert_temperature(32, "F", "K")
        assert abs(result - 273.15) < 1e-9, f"Expected 273.15, got {result}"

    def test_kelvin_to_fahrenheit(self):
        result = convert_temperature(273.15, "K", "F")
        assert abs(result - 32.0) < 1e-9, f"Expected 32.0, got {result}"

    def test_invalid_from_unit(self):
        with pytest.raises(ValueError):
            convert_temperature(100, "X", "C")

    def test_invalid_to_unit(self):
        with pytest.raises(ValueError):
            convert_temperature(100, "C", "X")


# ---------------------------------------------------------------------------
# Length conversion tests
# ---------------------------------------------------------------------------


class TestLengthConversion:
    def test_m_to_ft(self):
        result = convert_length(1, "m", "ft")
        assert abs(result - 3.28084) < 1e-4, f"Expected 3.28084, got {result}"

    def test_ft_to_m(self):
        result = convert_length(1, "ft", "m")
        assert abs(result - 0.3048) < 1e-4, f"Expected 0.3048, got {result}"

    def test_m_to_in(self):
        result = convert_length(1, "m", "in")
        assert abs(result - 39.3701) < 1e-4, f"Expected 39.3701, got {result}"

    def test_in_to_m(self):
        result = convert_length(1, "in", "m")
        assert abs(result - 0.0254) < 1e-4, f"Expected 0.0254, got {result}"

    def test_ft_to_in(self):
        result = convert_length(1, "ft", "in")
        assert abs(result - 12.0) < 1e-4, f"Expected 12.0, got {result}"

    def test_in_to_ft(self):
        result = convert_length(12, "in", "ft")
        assert abs(result - 1.0) < 1e-4, f"Expected 1.0, got {result}"

    def test_invalid_from_unit(self):
        with pytest.raises(ValueError):
            convert_length(1, "xyz", "m")

    def test_invalid_to_unit(self):
        with pytest.raises(ValueError):
            convert_length(1, "m", "xyz")


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------


CLI_SCRIPT = Path(__file__).resolve().parent / "unit_convert.py"


class TestCLIIntegration:
    def test_cli_temperature(self):
        result = subprocess.run(
            [sys.executable, str(CLI_SCRIPT),
             "--type", "temperature",
             "--value", "100",
             "--from", "C",
             "--to", "F"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        output = result.stdout.strip()
        assert output == "212.0"

    def test_cli_length(self):
        result = subprocess.run(
            [sys.executable, str(CLI_SCRIPT),
             "--type", "length",
             "--value", "1",
             "--from", "m",
             "--to", "ft"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        output = result.stdout.strip()
        assert abs(float(output) - 3.28084) < 1e-4