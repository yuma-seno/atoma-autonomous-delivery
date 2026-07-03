#!/usr/bin/env python3
"""Line count CLI tool - reads text from stdin and outputs the number of lines."""

import sys


def main() -> None:
    """Read stdin and print line count."""
    count = sum(1 for _ in sys.stdin)
    print(count)


if __name__ == "__main__":
    main()