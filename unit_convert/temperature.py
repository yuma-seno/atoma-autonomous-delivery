"""Temperature conversion module.

Provides conversion between Celsius (C), Fahrenheit (F), and Kelvin (K).
"""


def convert_temperature(value: float, from_unit: str, to_unit: str) -> float:
    """Convert a temperature value between units.

    Supported units: 'C' (Celsius), 'F' (Fahrenheit), 'K' (Kelvin).

    Args:
        value: The temperature value to convert.
        from_unit: The unit of the input value.
        to_unit: The target unit for conversion.

    Returns:
        The converted temperature value.

    Raises:
        ValueError: If either unit is not one of 'C', 'F', or 'K'.
    """
    valid_units = {"C", "F", "K"}
    if from_unit not in valid_units:
        raise ValueError(f"Unknown unit: {from_unit!r}. Expected one of {valid_units}")
    if to_unit not in valid_units:
        raise ValueError(f"Unknown unit: {to_unit!r}. Expected one of {valid_units}")

    if from_unit == to_unit:
        return value

    # Convert from from_unit to Celsius first (if not already Celsius)
    if from_unit == "F":
        celsius = (value - 32) * 5 / 9
    elif from_unit == "K":
        celsius = value - 273.15
    else:
        celsius = value

    # Convert from Celsius to to_unit
    if to_unit == "F":
        return celsius * 9 / 5 + 32
    elif to_unit == "K":
        return celsius + 273.15
    else:
        return celsius