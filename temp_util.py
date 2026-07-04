"""Temperature unit conversion utilities."""


def c_to_f(c: float) -> float:
    """Convert Celsius to Fahrenheit.

    Args:
        c: Temperature in degrees Celsius.

    Returns:
        Temperature in degrees Fahrenheit.
    """
    return c * 9.0 / 5.0 + 32.0


def f_to_c(f: float) -> float:
    """Convert Fahrenheit to Celsius.

    Args:
        f: Temperature in degrees Fahrenheit.

    Returns:
        Temperature in degrees Celsius.
    """
    return (f - 32.0) * 5.0 / 9.0


def c_to_k(c: float) -> float:
    """Convert Celsius to Kelvin.

    Args:
        c: Temperature in degrees Celsius.

    Returns:
        Temperature in Kelvin.
    """
    return c + 273.15


if __name__ == "__main__":
    # --- c_to_f tests ---
    print("c_to_f:")
    print(f"  0°C  -> {c_to_f(0):.2f}°F  (expected: 32.00)")
    print(f"  100°C -> {c_to_f(100):.2f}°F (expected: 212.00)")
    print(f"  -40°C -> {c_to_f(-40):.2f}°F (expected: -40.00)")

    # --- f_to_c tests ---
    print("\nf_to_c:")
    print(f"  32°F  -> {f_to_c(32):.2f}°C  (expected: 0.00)")
    print(f"  212°F -> {f_to_c(212):.2f}°C (expected: 100.00)")
    print(f"  -40°F -> {f_to_c(-40):.2f}°C (expected: -40.00)")

    # --- c_to_k tests ---
    print("\nc_to_k:")
    print(f"  0°C   -> {c_to_k(0):.2f}K   (expected: 273.15)")
    print(f"  100°C -> {c_to_k(100):.2f}K  (expected: 373.15)")
    print(f"  -273.15°C -> {c_to_k(-273.15):.2f}K (expected: 0.00)")