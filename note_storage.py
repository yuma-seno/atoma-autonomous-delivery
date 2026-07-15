"""Note storage module.

Provides functions to add, save, and load notes as JSON files.
Each note is a dict with keys: id, text, tags.
"""

import json
import os


def add_note(notes: list, text: str, tags: list) -> dict:
    """Add a new note to the notes list and return the created note.

    Each note has the format {"id": int, "text": str, "tags": list[str]}.
    IDs are sequential based on the maximum existing ID + 1 (or 1 if empty).
    The notes list is mutated in place.

    Args:
        notes: Existing list of note dicts (mutated in place).
        text: The text content of the new note.
        tags: List of tag strings (0 or more).

    Returns:
        The newly created note dict.
    """
    max_id = max((n["id"] for n in notes), default=0)
    new_note = {
        "id": max_id + 1,
        "text": text,
        "tags": tags,
    }
    notes.append(new_note)
    return new_note


def save_notes(notes: list, filepath: str) -> None:
    """Save a notes list to a JSON file.

    Args:
        notes: List of note dicts to save.
        filepath: Path to the output JSON file.
    """
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=2)


def load_notes(filepath: str) -> list:
    """Load a notes list from a JSON file.

    If the file does not exist, returns an empty list.

    Args:
        filepath: Path to the JSON file.

    Returns:
        List of note dicts, or an empty list if the file is missing.
    """
    if not os.path.exists(filepath):
        return []
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)