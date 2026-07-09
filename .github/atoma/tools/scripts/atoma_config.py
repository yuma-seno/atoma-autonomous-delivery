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


def get_merge_policy(default: str = "manual") -> str:
    """Look up the top-level `merge_policy` from config.json."""
    return load_config().get("merge_policy", default)


def get_trigger_agent(event: str, default: str = "") -> str:
    """Look up the agent configured for an unconditional `auto_triggers` event.

    Entries with a `condition` (e.g. changes_requested) are evaluated by
    match_trigger.py at workflow time, not here, so they're skipped -- this is
    only for simple event->agent lookups like "who reviews a newly opened PR".
    """
    for trigger in load_config().get("auto_triggers", []):
        if trigger.get("event") == event and "condition" not in trigger:
            return trigger.get("agent", default)
    return default
