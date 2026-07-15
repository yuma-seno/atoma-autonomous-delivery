#!/usr/bin/env python3
"""CLI entry point for note management.

Usage:
    python note_cli.py add "Note text" --tags tag1,tag2
    python note_cli.py list
    python note_cli.py tag <tag>
    python note_cli.py search <keyword>

Optional:
    --file PATH   Path to the notes JSON file (default: notes.json)
"""

import argparse
import json
import sys

from note_query import find_by_keyword, find_by_tag
from note_storage import add_note, load_notes, save_notes


def build_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser."""
    parser = argparse.ArgumentParser(
        description="Note management tool",
    )
    parser.add_argument(
        "--file",
        default="notes.json",
        help="Path to the notes JSON file (default: notes.json)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # add subcommand
    add_parser = subparsers.add_parser("add", help="Add a new note")
    add_parser.add_argument("text", nargs="?", default=None, help="Note text")
    add_parser.add_argument(
        "--tags",
        default="",
        help="Comma-separated list of tags (e.g. tag1,tag2)",
    )

    # list subcommand
    subparsers.add_parser("list", help="List all notes")

    # tag subcommand
    tag_parser = subparsers.add_parser("tag", help="Filter notes by tag")
    tag_parser.add_argument(
        "tag", nargs="?", default=None, help="Tag to filter by"
    )

    # search subcommand
    search_parser = subparsers.add_parser(
        "search", help="Search notes by keyword"
    )
    search_parser.add_argument(
        "keyword", nargs="?", default=None, help="Search keyword"
    )

    return parser


def _load_or_empty(filepath: str) -> list:
    """Load notes, returning an empty list on corrupt file."""
    try:
        return load_notes(filepath)
    except json.JSONDecodeError:
        return []


def _parse_tags(tags_str: str) -> list:
    """Parse a comma-separated tag string into a list of trimmed strings.

    Returns an empty list if the input is empty or whitespace-only.
    """
    if not tags_str or not tags_str.strip():
        return []
    return [t.strip() for t in tags_str.split(",") if t.strip()]


def _print_notes(notes: list) -> None:
    """Print a list of notes in a human-readable format."""
    if not notes:
        print("No notes found.")
        return
    for note in notes:
        tags = ", ".join(note.get("tags", []))
        if tags:
            print(f"[{note['id']}] {note['text']}  (tags: {tags})")
        else:
            print(f"[{note['id']}] {note['text']}")


def cmd_add(args: argparse.Namespace) -> int:
    """Handle the ``add`` subcommand."""
    if not args.text:
        print("Error: note text is required", file=sys.stderr)
        return 1

    notes = _load_or_empty(args.file)
    tags = _parse_tags(args.tags)
    new_note = add_note(notes, args.text, tags)
    save_notes(notes, args.file)
    print(f"Added note #{new_note['id']}: {args.text}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    """Handle the ``list`` subcommand."""
    notes = _load_or_empty(args.file)
    _print_notes(notes)
    return 0


def cmd_tag(args: argparse.Namespace) -> int:
    """Handle the ``tag`` subcommand."""
    if not args.tag:
        print("Error: tag is required", file=sys.stderr)
        return 1

    notes = _load_or_empty(args.file)
    results = find_by_tag(notes, args.tag)
    _print_notes(results)
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    """Handle the ``search`` subcommand."""
    if not args.keyword:
        print("Error: keyword is required", file=sys.stderr)
        return 1

    notes = _load_or_empty(args.file)
    results = find_by_keyword(notes, args.keyword)
    _print_notes(results)
    return 0


def main(argv: list[str] | None = None) -> int:
    """Entry point. Parses arguments and dispatches to the appropriate handler.

    Args:
        argv: Command-line arguments (defaults to sys.argv[1:]).

    Returns:
        Exit code (0 for success, 1 for error).
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    handlers = {
        "add": cmd_add,
        "list": cmd_list,
        "tag": cmd_tag,
        "search": cmd_search,
    }

    handler = handlers.get(args.command)
    if handler is None:
        parser.print_usage()
        return 1

    return handler(args)


if __name__ == "__main__":
    sys.exit(main())