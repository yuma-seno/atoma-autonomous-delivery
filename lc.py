#!/usr/bin/env python3
import sys


def count_lines(filepath):
    """Count lines in a file.

    Counts newline characters and handles files without a trailing newline.
    """
    with open(filepath, 'rb') as f:
        data = f.read()
    if not data:
        return 0
    count = data.count(b'\n')
    if not data.endswith(b'\n'):
        count += 1
    return count


def main():
    files = sys.argv[1:]
    if not files:
        print(f"Usage: python {__file__} <file1> [file2 ...]", file=sys.stderr)
        sys.exit(1)

    total = 0
    has_error = False
    results = []

    for f in files:
        try:
            c = count_lines(f)
            results.append((c, f))
            total += c
        except FileNotFoundError:
            print(f"lc.py: {f}: No such file", file=sys.stderr)
            has_error = True
            results.append((None, f))

    for count, name in results:
        if count is not None:
            print(f"{count} {name}")

    if len(files) > 1:
        print(f"{total} total")

    sys.exit(1 if has_error else 0)


if __name__ == "__main__":
    main()