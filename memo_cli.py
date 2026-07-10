#!/usr/bin/env python3
"""CLI entry point for memo management.

Usage:
    python memo_cli.py add "メモ内容"
    python memo_cli.py list
    python memo_cli.py search "キーワード"

Optional:
    --file PATH   Path to the memo JSON file (default: memos.json)
"""

import argparse
import json
import sys

from memo_search import search_memos
from memo_storage import add_memo, load_memos, save_memos


def build_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser."""
    parser = argparse.ArgumentParser(
        description="Memo management tool",
    )
    parser.add_argument(
        "--file",
        default="memos.json",
        help="Path to the memo JSON file (default: memos.json)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # add subcommand
    add_parser = subparsers.add_parser("add", help="Add a new memo")
    add_parser.add_argument("text", nargs="?", default=None, help="Memo text")

    # list subcommand
    subparsers.add_parser("list", help="List all memos")

    # search subcommand
    search_parser = subparsers.add_parser("search", help="Search memos by keyword")
    search_parser.add_argument("keyword", nargs="?", default=None, help="Search keyword")

    return parser


def _load_or_empty(filepath: str) -> list:
    """Load memos, returning an empty list on empty/corrupt file."""
    try:
        return load_memos(filepath)
    except json.JSONDecodeError:
        return []


def cmd_add(args: argparse.Namespace) -> int:
    """Handle the ``add`` subcommand."""
    if not args.text:
        print("Error: memo text is required", file=sys.stderr)
        return 1

    memos = _load_or_empty(args.file)
    memos = add_memo(memos, args.text)
    save_memos(memos, args.file)
    print(f"Added memo: {args.text}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    """Handle the ``list`` subcommand."""
    memos = _load_or_empty(args.file)
    if not memos:
        print("No memos found.")
        return 0

    for memo in memos:
        print(f"[{memo['id']}] {memo['text']}  ({memo['created_at']})")
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    """Handle the ``search`` subcommand."""
    memos = _load_or_empty(args.file)
    keyword = args.keyword or ""
    results = search_memos(memos, keyword)

    if not results:
        if keyword:
            print(f"No memos found matching '{keyword}'.")
        else:
            print("No memos found.")
        return 0

    for memo in results:
        print(f"[{memo['id']}] {memo['text']}  ({memo['created_at']})")
    return 0


def main() -> int:
    """Entry point. Parses arguments and dispatches to the appropriate handler."""
    parser = build_parser()
    args = parser.parse_args()

    handlers = {
        "add": cmd_add,
        "list": cmd_list,
        "search": cmd_search,
    }

    handler = handlers.get(args.command)
    if handler is None:
        parser.print_usage()
        return 1

    return handler(args)


if __name__ == "__main__":
    sys.exit(main())