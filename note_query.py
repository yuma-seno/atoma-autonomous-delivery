"""Note query module.

Provides functions to search/filter notes by tag or keyword,
and to collect all unique tags across a list of notes.
"""


def find_by_tag(notes: list, tag: str) -> list:
    """Return notes that have the specified tag (non-destructive).

    Each note dict should contain a ``tags`` key whose value is a list of strings.

    Args:
        notes: List of note dicts.
        tag: Tag string to search for.

    Returns:
        New list containing only notes that include *tag* in their ``tags`` list.
    """
    return [n for n in notes if tag in n.get("tags", [])]


def find_by_keyword(notes: list, keyword: str) -> list:
    """Return notes whose text contains the keyword (case-insensitive, non-destructive).

    Each note dict should contain a ``text`` key.

    Args:
        notes: List of note dicts.
        keyword: Search string (case-insensitive).

    Returns:
        New list containing only notes whose ``text`` includes *keyword*.
    """
    keyword_lower = keyword.lower()
    return [n for n in notes if keyword_lower in n.get("text", "").lower()]


def all_tags(notes: list) -> list:
    """Return a sorted list of all unique tags used across all notes.

    Args:
        notes: List of note dicts.

    Returns:
        Sorted list of unique tag strings.
    """
    tags = set()
    for n in notes:
        tags.update(n.get("tags", []))
    return sorted(tags)