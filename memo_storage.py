"""Memo storage module.

Provides functions to add, save, and load memos as JSON files.
Each memo is a dict with keys: id, text, created_at.
"""

import json
import os
from datetime import datetime, timezone


def add_memo(memos: list, text: str) -> list:
    """Add a new memo to the memo list and return a new list.

    Each memo has the format {"id": int, "text": str, "created_at": str}.
    IDs are sequential based on the maximum existing ID + 1.

    Args:
        memos: Existing list of memo dicts.
        text: The text content of the new memo.

    Returns:
        A new list with the memo appended.
    """
    max_id = max((m["id"] for m in memos), default=0)
    new_memo = {
        "id": max_id + 1,
        "text": text,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    return [*memos, new_memo]


def save_memos(memos: list, filepath: str) -> None:
    """Save a memo list to a JSON file.

    Args:
        memos: List of memo dicts to save.
        filepath: Path to the output JSON file.
    """
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(memos, f, ensure_ascii=False, indent=2)


def load_memos(filepath: str) -> list:
    """Load a memo list from a JSON file.

    If the file does not exist, returns an empty list.

    Args:
        filepath: Path to the JSON file.

    Returns:
        List of memo dicts, or an empty list if the file is missing.
    """
    if not os.path.exists(filepath):
        return []
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)