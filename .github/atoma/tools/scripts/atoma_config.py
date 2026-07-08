#!/usr/bin/env python3
"""Shared helper for reading .github/atoma/config.json.

Imported by other scripts in this directory (Python adds a script's own
directory to sys.path, so `import atoma_config` works from any script here).
Assumes the current working directory is the repository root, matching how
all Atoma workflow steps invoke these scripts.
"""

from __future__ import annotations

import json

CONFIG_PATH = ".github/atoma/config.json"


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def get_label(key: str, default: str) -> str:
    """Look up a label from the top-level `labels` section of config.json."""
    return load_config().get("labels", {}).get(key, default)
