#!/usr/bin/env python3
"""Task CLI — A simple task management tool.

Usage:
    python3 taskcli.py add "Buy groceries"
    python3 taskcli.py list
    python3 taskcli.py list --all
    python3 taskcli.py done <ID>
    python3 taskcli.py delete <ID>
"""

import argparse
import json
import os
import sys
from datetime import datetime

DATA_FILE = ".taskcli.json"


class TaskStore:
    """Persistent task storage using a local JSON file."""

    def __init__(self, path=None):
        self.path = path or DATA_FILE
        self._tasks = self._load()

    def _load(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._tasks, f, indent=2, ensure_ascii=False)

    def _next_id(self):
        if not self._tasks:
            return 1
        return max(t["id"] for t in self._tasks) + 1

    def add(self, description):
        task = {
            "id": self._next_id(),
            "description": description,
            "created_at": datetime.now().isoformat(),
            "done": False,
        }
        self._tasks.append(task)
        self._save()
        return task

    def list_tasks(self, include_done=False):
        if include_done:
            return list(self._tasks)
        return [t for t in self._tasks if not t["done"]]

    def mark_done(self, task_id):
        for task in self._tasks:
            if task["id"] == task_id:
                task["done"] = True
                self._save()
                return task
        return None

    def delete(self, task_id):
        for i, task in enumerate(self._tasks):
            if task["id"] == task_id:
                removed = self._tasks.pop(i)
                self._save()
                return removed
        return None


def cmd_add(args, store):
    task = store.add(args.description)
    print(f"Added task {task['id']}: {task['description']}")


def cmd_list(args, store):
    tasks = store.list_tasks(include_done=args.all)
    if not tasks:
        print("No tasks.")
        return
    for task in tasks:
        suffix = " [done]" if task["done"] else ""
        print(f"{task['id']}: {task['description']}{suffix}")


def cmd_done(args, store):
    task = store.mark_done(args.task_id)
    if task is None:
        print("Task not found.", file=sys.stderr)
        sys.exit(1)
    print(f"Task {args.task_id} marked as done.")


def cmd_delete(args, store):
    task = store.delete(args.task_id)
    if task is None:
        print("Task not found.", file=sys.stderr)
        sys.exit(1)
    print(f"Task {args.task_id} deleted.")


def main():
    parser = argparse.ArgumentParser(description="Simple task management CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # add
    parser_add = subparsers.add_parser("add", help="Add a new task")
    parser_add.add_argument("description", help="Task description")
    parser_add.set_defaults(func=cmd_add)

    # list
    parser_list = subparsers.add_parser("list", help="List tasks")
    parser_list.add_argument("--all", action="store_true", help="Include done tasks")
    parser_list.set_defaults(func=cmd_list)

    # done
    parser_done = subparsers.add_parser("done", help="Mark a task as done")
    parser_done.add_argument("task_id", type=int, help="Task ID")
    parser_done.set_defaults(func=cmd_done)

    # delete
    parser_delete = subparsers.add_parser("delete", help="Delete a task")
    parser_delete.add_argument("task_id", type=int, help="Task ID")
    parser_delete.set_defaults(func=cmd_delete)

    args = parser.parse_args()
    store = TaskStore()
    args.func(args, store)


if __name__ == "__main__":
    main()