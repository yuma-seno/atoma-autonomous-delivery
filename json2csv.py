#!/usr/bin/env python3
"""Convert JSON array from stdin to CSV on stdout."""

import csv
import json
import sys


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Error: invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(data, list):
        print("Error: input must be a JSON array", file=sys.stderr)
        sys.exit(1)

    # Collect all keys from all objects (preserve insertion order)
    fieldnames: list[str] = []
    seen: set[str] = set()
    for item in data:
        if isinstance(item, dict):
            for key in item:
                if key not in seen:
                    seen.add(key)
                    fieldnames.append(key)

    writer = csv.DictWriter(sys.stdout, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()

    for item in data:
        if isinstance(item, dict):
            writer.writerow(item)


if __name__ == "__main__":
    main()