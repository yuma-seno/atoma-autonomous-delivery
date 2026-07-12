"""Filter module for ToDo task lists.

A task is a dict with keys: id, title, priority, done.
All filter functions return a new list without mutating the input.
"""


def filter_by_status(tasks: list, done: bool) -> list:
    """Return tasks matching the given done/not-done status."""
    return [t for t in tasks if t["done"] == done]


def filter_by_priority(tasks: list, priority: int) -> list:
    """Return tasks with the exact given priority."""
    return [t for t in tasks if t["priority"] == priority]


def filter_by_priority_range(tasks: list, min_p: int, max_p: int) -> list:
    """Return tasks with priority in [min_p, max_p] (inclusive)."""
    return [t for t in tasks if min_p <= t["priority"] <= max_p]