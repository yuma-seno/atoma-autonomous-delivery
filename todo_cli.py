"""CLI entry point for the ToDo task manager.

Combines the storage module (todo_storage) and filter module (todo_filter)
into a single command-line interface.

Usage:
    python todo_cli.py add <title> <priority>
    python todo_cli.py list
    python todo_cli.py done <id>
    python todo_cli.py filter --status <done|pending>
    python todo_cli.py filter --priority <N>
    python todo_cli.py filter --priority-min <N> --priority-max <M>
"""

import argparse
import sys

from todo_filter import (
    filter_by_priority,
    filter_by_priority_range,
    filter_by_status,
)
from todo_storage import add_task, load_tasks, mark_done, save_tasks

DEFAULT_FILE = "tasks.json"


def create_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser.

    Returns:
        An ArgumentParser instance with all subcommands configured.
    """
    parser = argparse.ArgumentParser(
        prog="todo_cli.py",
        description="A simple ToDo task manager.",
    )
    parser.add_argument(
        "--file",
        default=DEFAULT_FILE,
        help=f"Path to the tasks JSON file (default: {DEFAULT_FILE})",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # --- add ---
    add_parser = subparsers.add_parser("add", help="Add a new task")
    add_parser.add_argument("title", help="Task title")
    add_parser.add_argument(
        "priority", type=int, help="Task priority (integer)"
    )

    # --- list ---
    subparsers.add_parser("list", help="List all tasks")

    # --- done ---
    done_parser = subparsers.add_parser("done", help="Mark a task as done")
    done_parser.add_argument("id", type=int, help="Task ID to mark as done")

    # --- filter ---
    filter_parser = subparsers.add_parser("filter", help="Filter tasks")
    filter_status = filter_parser.add_mutually_exclusive_group()
    filter_status.add_argument(
        "--status",
        choices=["done", "pending"],
        help="Filter by completion status",
    )
    filter_parser.add_argument(
        "--priority", type=int, help="Filter by exact priority"
    )
    filter_parser.add_argument(
        "--priority-min", type=int, help="Minimum priority (inclusive)"
    )
    filter_parser.add_argument(
        "--priority-max", type=int, help="Maximum priority (inclusive)"
    )

    return parser


def _print_tasks(tasks: list) -> None:
    """Print a list of tasks in a human-readable format."""
    if not tasks:
        print("No tasks found.")
        return
    for task in tasks:
        status = "✓" if task["done"] else " "
        print(
            f"[{status}] {task['id']:>3}. {task['title']} "
            f"(priority: {task['priority']})"
        )


def run_add(args: argparse.Namespace) -> None:
    """Handle the 'add' command."""
    tasks = load_tasks(args.file)
    new_task = add_task(tasks, args.title, args.priority)
    tasks.append(new_task)
    save_tasks(tasks, args.file)
    print(f"Added task #{new_task['id']}: {args.title}")


def run_list(args: argparse.Namespace) -> None:
    """Handle the 'list' command."""
    tasks = load_tasks(args.file)
    _print_tasks(tasks)


def run_done(args: argparse.Namespace) -> None:
    """Handle the 'done' command."""
    tasks = load_tasks(args.file)
    found = mark_done(tasks, args.id)
    if found:
        save_tasks(tasks, args.file)
        print(f"Task #{args.id} marked as done.")
    else:
        print(f"Task #{args.id} not found.")


def run_filter(args: argparse.Namespace) -> None:
    """Handle the 'filter' command."""
    tasks = load_tasks(args.file)

    # Apply filters in sequence
    if args.status is not None:
        done = args.status == "done"
        tasks = filter_by_status(tasks, done)
    if args.priority is not None:
        tasks = filter_by_priority(tasks, args.priority)
    if args.priority_min is not None or args.priority_max is not None:
        pmin = args.priority_min if args.priority_min is not None else 0
        pmax = (
            args.priority_max
            if args.priority_max is not None
            else 999_999_999
        )
        tasks = filter_by_priority_range(tasks, pmin, pmax)

    _print_tasks(tasks)


def main(argv: list[str] | None = None) -> None:
    """Entry point for the CLI.

    Args:
        argv: Command-line arguments (defaults to sys.argv[1:]).
    """
    parser = create_parser()
    args = parser.parse_args(argv)

    if args.command == "add":
        run_add(args)
    elif args.command == "list":
        run_list(args)
    elif args.command == "done":
        run_done(args)
    elif args.command == "filter":
        run_filter(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
