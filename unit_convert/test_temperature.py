"""Tests for temperature conversion module."""

from unit_convert.temperature import convert_temperature


def test_celsius_to_fahrenheit():
    assert convert_temperature(100, "C", "F") == 212.0


def test_fahrenheit_to_celsius():
    assert convert_temperature(32, "F", "C") == 0.0


def test_kelvin_to_celsius():
    assert convert_temperature(0, "K", "C") == -273.15


def test_celsius_to_kelvin():
    assert convert_temperature(0, "C", "K") == 273.15


def test_identity():
    assert convert_temperature(0, "C", "C") == 0.0
    assert convert_temperature(100, "F", "F") == 100.0
    assert convert_temperature(300, "K", "K") == 300.0


def test_fahrenheit_to_kelvin():
    assert convert_temperature(32, "F", "K") == 273.15


def test_kelvin_to_fahrenheit():
    result = convert_temperature(0, "K", "F")
    assert abs(result - (-459.67)) < 1e-9, f"Expected -459.67, got {result}"


def test_fahrenheit_to_celsius_212():
    assert convert_temperature(212, "F", "C") == 100.0


def test_invalid_from_unit():
    try:
        convert_temperature(100, "X", "C")
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_invalid_to_unit():
    try:
        convert_temperature(100, "C", "X")
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


if __name__ == "__main__":
    test_celsius_to_fahrenheit()
    test_fahrenheit_to_celsius()
    test_kelvin_to_celsius()
    test_celsius_to_kelvin()
    test_identity()
    test_fahrenheit_to_kelvin()
    test_kelvin_to_fahrenheit()
    test_fahrenheit_to_celsius_212()
    test_invalid_from_unit()
    test_invalid_to_unit()
    print("All tests passed!")