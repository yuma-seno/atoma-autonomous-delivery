#!/usr/bin/env python3
"""lc.py - A simple line count CLI tool (like wc -l) using only Python stdlib."""

import sys


def count_lines(file_obj):
    """Count lines in an open file object using newline character."""
    return sum(1 for _ in file_obj)


def count_lines_in_file(path):
    """Count lines in a file by path. Returns (count, path) or raises on error."""
    try:
        with open(path, "r") as f:
            return count_lines(f), path
    except FileNotFoundError:
        print(f"lc: {path}: No such file or directory", file=sys.stderr)
        return None
    except IsADirectoryError:
        print(f"lc: {path}: Is a directory", file=sys.stderr)
        return None
    except PermissionError:
        print(f"lc: {path}: Permission denied", file=sys.stderr)
        return None
    except Exception as e:
        print(f"lc: {path}: {e}", file=sys.stderr)
        return None


def main():
    args = sys.argv[1:]

    # Filter out -l flag (default behavior is line counting)
    files = [arg for arg in args if arg != "-l"]

    if not files:
        # No file arguments - read from stdin
        count = count_lines(sys.stdin)
        print(f"{count}")
        return

    results = []
    has_error = False

    for path in files:
        result = count_lines_in_file(path)
        if result is None:
            has_error = True
        else:
            results.append(result)

    for count, path in results:
        print(f"{count}\t{path}")

    if len(results) > 1:
        total = sum(count for count, _ in results)
        print(f"{total}\ttotal")

    sys.exit(1 if has_error else 0)


if __name__ == "__main__":
    main()