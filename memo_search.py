"""Memo search module.

Provides case-insensitive keyword search over a list of memo dictionaries.
"""


def search_memos(memos: list, keyword: str) -> list:
    """Filter memos that contain *keyword* (case-insensitive).

    Args:
        memos: List of dicts with keys ``id``, ``text``, ``created_at``.
        keyword: Search string (empty string returns all memos).

    Returns:
        Filtered list of memo dicts.
    """
    if not keyword:
        return memos

    keyword_lower = keyword.lower()
    return [m for m in memos if keyword_lower in m.get("text", "").lower()]