#!/usr/bin/env python3
"""Simple line count tool that reads from stdin and outputs the line count."""

import sys


def main() -> None:
    count = 0
    for _ in sys.stdin:
        count += 1
    print(count)


if __name__ == "__main__":
    main()
