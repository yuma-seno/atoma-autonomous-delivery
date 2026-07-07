#!/usr/bin/env python3
"""Print a dotted-path value from .github/atoma/config.json.

Usage:
  get_config_value.py <dotted.path> [default]

Examples:
  get_config_value.py agents.engineer.max_iterations 30
  get_config_value.py labels.in_progress atoma/in-progress
"""

from __future__ import annotations

import sys

from atoma_config import load_config


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: get_config_value.py <dotted.path> [default]", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    default = sys.argv[2] if len(sys.argv) > 2 else ""

    node = load_config()
    for key in path.split("."):
        if isinstance(node, dict) and key in node:
            node = node[key]
        else:
            print(default)
            return
    print(node)


if __name__ == "__main__":
    main()
