"""ToDo storage module.

Provides functions to create, persist, and manage ToDo tasks in JSON format.
Each task is a dict with keys: id, title, priority, done.
"""

import json
import os


def add_task(tasks: list, title: str, priority: int) -> dict:
    """Create a new task dict with an auto-incremented id.

    The new id is computed as max(existing ids) + 1, or 1 if the list is empty.

    Args:
        tasks: Existing list of task dicts.
        title: The title of the task.
        priority: The priority level of the task.

    Returns:
        A new task dict with keys id, title, priority, and done (False).
    """
    max_id = max((t["id"] for t in tasks), default=0)
    return {
        "id": max_id + 1,
        "title": title,
        "priority": priority,
        "done": False,
    }


def save_tasks(tasks: list, filepath: str) -> None:
    """Serialize a task list to a JSON file.

    Args:
        tasks: List of task dicts to save.
        filepath: Path to the output JSON file.
    """
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(tasks, f, ensure_ascii=False, indent=2)


def load_tasks(filepath: str) -> list:
    """Deserialize a task list from a JSON file.

    If the file does not exist, returns an empty list.

    Args:
        filepath: Path to the JSON file.

    Returns:
        List of task dicts, or an empty list if the file is missing.
    """
    if not os.path.exists(filepath):
        return []
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def mark_done(tasks: list, task_id: int) -> bool:
    """Mark a task as done by its id.

    Mutates the task in place. Returns True if the task was found,
    False otherwise.

    Args:
        tasks: List of task dicts.
        task_id: The id of the task to mark as done.

    Returns:
        True if the task was found and marked, False otherwise.
    """
    for task in tasks:
        if task["id"] == task_id:
            task["done"] = True
            return True
    return False