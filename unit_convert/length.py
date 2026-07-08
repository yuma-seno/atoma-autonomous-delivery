"""Length conversion module.

Supported units: m (meters), ft (feet), in (inches).
All conversions are based on the meter as the reference unit.
"""

_CONVERSION_TO_METER = {
    "m": 1.0,
    "ft": 0.3048,
    "in": 0.0254,
}

_VALID_UNITS = set(_CONVERSION_TO_METER.keys())


def convert_length(value: float, from_unit: str, to_unit: str) -> float:
    """Convert a length value from one unit to another.

    Args:
        value: The numeric length value to convert.
        from_unit: The source unit string ('m', 'ft', or 'in').
        to_unit: The target unit string ('m', 'ft', or 'in').

    Returns:
        The converted length value in the target unit.

    Raises:
        ValueError: If either from_unit or to_unit is not a supported unit.
    """
    if from_unit not in _VALID_UNITS:
        raise ValueError(f"Unsupported unit: '{from_unit}'. Supported units: {sorted(_VALID_UNITS)}")
    if to_unit not in _VALID_UNITS:
        raise ValueError(f"Unsupported unit: '{to_unit}'. Supported units: {sorted(_VALID_UNITS)}")

    value_in_meters = value * _CONVERSION_TO_METER[from_unit]
    converted_value = value_in_meters / _CONVERSION_TO_METER[to_unit]
    return converted_value
