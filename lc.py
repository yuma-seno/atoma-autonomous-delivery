#!/usr/bin/env python3
"""lc.py — Count lines in files (like `wc -l`).

Usage:
  python lc.py [file ...]

If no files are given, read from stdin.
With multiple files, show individual counts and a total.
"""

import sys


def count_lines(stream) -> int:
    """Count lines as number of newline characters in the stream."""
    return sum(1 for _ in stream)


def main() -> None:
    files = sys.argv[1:]
    total = 0
    exit_code = 0

    if not files:
        # Read from stdin
        count = count_lines(sys.stdin)
        print(count)
        return

    for fname in files:
        try:
            with open(fname, "r") as f:
                count = count_lines(f)
        except FileNotFoundError:
            print(f"lc.py: {fname}: No such file or directory", file=sys.stderr)
            exit_code = 1
            continue
        except IsADirectoryError:
            print(f"lc.py: {fname}: Is a directory", file=sys.stderr)
            exit_code = 1
            continue
        except PermissionError:
            print(f"lc.py: {fname}: Permission denied", file=sys.stderr)
            exit_code = 1
            continue

        print(f"{count:>7} {fname}")
        total += count

    if len(files) > 1:
        print(f"{total:>7} total")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
