#!/usr/bin/env python3
"""Convert a JSON array from stdin to CSV on stdout."""

import csv
import json
import sys


def get_all_keys(objects):
    """Return the union of all keys across all objects, preserving insertion order."""
    keys = []
    seen = set()
    for obj in objects:
        for key in obj:
            if key not in seen:
                seen.add(key)
                keys.append(key)
    return keys


def flatten_value(value):
    """If value is a dict or list, return its JSON serialization; otherwise return as-is."""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def show_help():
    print("Usage: json2csv.py < input.json > output.csv", file=sys.stderr)
    print("Convert a JSON array from stdin to CSV on stdout.", file=sys.stderr)
    print(file=sys.stderr)
    print("Options:", file=sys.stderr)
    print("  -h, --help  Show this help message", file=sys.stderr)


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        show_help()
        sys.exit(0)

    raw = sys.stdin.read()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(data, list):
        print("Error: Input must be a JSON array.", file=sys.stderr)
        sys.exit(1)

    if not data:
        sys.exit(0)

    keys = get_all_keys(data)
    writer = csv.writer(sys.stdout)
    writer.writerow(keys)

    for obj in data:
        row = []
        for key in keys:
            value = obj.get(key, "")
            row.append(flatten_value(value))
        writer.writerow(row)


if __name__ == "__main__":
    main()
