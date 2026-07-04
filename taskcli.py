"""Task management CLI tool — data persistence layer."""

import json
import os
from datetime import datetime


class TaskStore:
    """Manages persistence of tasks to a JSON file.

    Each task is a dictionary with keys:
        id (int): 1-based sequential ID
        description (str): task description
        created_at (str): ISO 8601 datetime string
        done (bool): completion flag
    """

    def __init__(self, path=".taskcli.json"):
        self.path = path

    def load(self) -> list[dict]:
        """Load tasks from the JSON file. Returns an empty list if the file does not exist."""
        if not os.path.exists(self.path):
            return []
        try:
            with open(self.path, "r") as f:
                data = json.load(f)
            if not isinstance(data, list):
                raise ValueError("Invalid task data: expected a list")
            return data
        except (json.JSONDecodeError, ValueError) as e:
            raise ValueError(f"Failed to load tasks: {e}") from e

    def save(self, tasks: list[dict]):
        """Save the given task list to the JSON file."""
        with open(self.path, "w") as f:
            json.dump(tasks, f, indent=2, ensure_ascii=False)

    def add(self, description: str) -> dict:
        """Add a new task and return it. The ID is auto-incremented."""
        tasks = self.load()
        new_id = max((t["id"] for t in tasks), default=0) + 1
        task = {
            "id": new_id,
            "description": description,
            "created_at": datetime.now().isoformat(),
            "done": False,
        }
        tasks.append(task)
        self.save(tasks)
        return task

    def get_by_id(self, task_id: int) -> dict | None:
        """Return the task with the given ID, or None if not found."""
        tasks = self.load()
        for task in tasks:
            if task["id"] == task_id:
                return task
        return None

    def list_tasks(self, include_done: bool = False) -> list[dict]:
        """Return tasks. If include_done is False, only return incomplete tasks."""
        tasks = self.load()
        if include_done:
            return tasks
        return [t for t in tasks if not t["done"]]

    def mark_done(self, task_id: int) -> dict | None:
        """Mark a task as done. Return the updated task, or None if not found."""
        tasks = self.load()
        for task in tasks:
            if task["id"] == task_id:
                task["done"] = True
                self.save(tasks)
                return task
        return None

    def delete(self, task_id: int) -> bool:
        """Delete a task by ID. Return True on success, False if not found."""
        tasks = self.load()
        for i, task in enumerate(tasks):
            if task["id"] == task_id:
                del tasks[i]
                self.save(tasks)
                return True
        return False