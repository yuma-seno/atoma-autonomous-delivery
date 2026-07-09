#!/usr/bin/env python3
"""Main CLI script for unit conversion.

Usage:
    python unit_convert.py --type temperature --value 100 --from C --to F
    python unit_convert.py --type length --value 1 --from m --to ft
"""

import argparse
import sys

from unit_convert.temperature import convert_temperature
from unit_convert.length import convert_length

_CONVERTERS = {
    "temperature": convert_temperature,
    "length": convert_length,
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert units between different systems.")
    parser.add_argument(
        "--type",
        required=True,
        choices=list(_CONVERTERS.keys()),
        help="Type of conversion: temperature or length",
    )
    parser.add_argument(
        "--value",
        required=True,
        type=float,
        help="Numeric value to convert",
    )
    parser.add_argument(
        "--from",
        required=True,
        dest="from_unit",
        help="Source unit (e.g., C, F, K for temperature; m, ft, in for length)",
    )
    parser.add_argument(
        "--to",
        required=True,
        dest="to_unit",
        help="Target unit (e.g., C, F, K for temperature; m, ft, in for length)",
    )

    args = parser.parse_args()

    converter = _CONVERTERS[args.type]

    try:
        result = converter(args.value, args.from_unit, args.to_unit)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # Round to 5 decimal places for clean output
    rounded_result = round(result, 5)
    print(f"{args.value} {args.from_unit} = {rounded_result} {args.to_unit}")


if __name__ == "__main__":
    main()