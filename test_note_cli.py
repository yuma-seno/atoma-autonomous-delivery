"""Unit tests for note_cli.py CLI logic.

Tests focus on argument parsing, command routing, and the printed output
of each subcommand. File I/O is isolated using temporary files.
"""

import os
import sys
import tempfile
from io import StringIO

import pytest

from note_cli import (
    _parse_tags,
    build_parser,
    cmd_add,
    cmd_list,
    cmd_search,
    cmd_tag,
    main,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _capture_main(argv: list[str]) -> str:
    """Run main() with the given argv and return captured stdout."""
    old_stdout = sys.stdout
    sys.stdout = StringIO()
    try:
        main(argv)
        return sys.stdout.getvalue()
    finally:
        sys.stdout = old_stdout


def _fresh_path() -> str:
    """Create a temporary file path that does not exist yet."""
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    os.unlink(path)
    return path


def _make_path(notes: list) -> str:
    """Create a temporary JSON file pre-populated with *notes*."""
    import json

    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(notes, f)
    return path


def _args(**kwargs):
    """Build a simple argparse.Namespace stand-in."""
    return type("Args", (), kwargs)()


# ---------------------------------------------------------------------------
# _parse_tags
# ---------------------------------------------------------------------------


class TestParseTags:
    """Tests for the _parse_tags helper."""

    def test_empty_string(self):
        assert _parse_tags("") == []

    def test_whitespace_only(self):
        assert _parse_tags("   ") == []

    def test_single_tag(self):
        assert _parse_tags("python") == ["python"]

    def test_multiple_tags(self):
        assert _parse_tags("a,b,c") == ["a", "b", "c"]

    def test_tags_with_spaces(self):
        assert _parse_tags(" personal ,  work ") == ["personal", "work"]

    def test_trailing_comma_ignored(self):
        assert _parse_tags("a,b,") == ["a", "b"]


# ---------------------------------------------------------------------------
# build_parser
# ---------------------------------------------------------------------------


class TestBuildParser:
    """Tests for argument parser construction."""

    def test_default_file(self):
        """Default --file should be 'notes.json'."""
        parser = build_parser()
        ns = parser.parse_args(["list"])
        assert ns.file == "notes.json"

    def test_custom_file(self):
        """--file flag should override the default path."""
        parser = build_parser()
        ns = parser.parse_args(["--file", "mynotes.json", "list"])
        assert ns.file == "mynotes.json"

    def test_add_parses_text(self):
        """add <text> stores the text as a string."""
        parser = build_parser()
        ns = parser.parse_args(["add", "Hello world"])
        assert ns.command == "add"
        assert ns.text == "Hello world"

    def test_add_parses_tags(self):
        """add ... --tags t1,t2 stores tags string."""
        parser = build_parser()
        ns = parser.parse_args(["add", "Hello", "--tags", "t1,t2"])
        assert ns.tags == "t1,t2"

    def test_list_command_no_arg(self):
        """list command takes no additional positional args."""
        parser = build_parser()
        ns = parser.parse_args(["list"])
        assert ns.command == "list"

    def test_tag_parses_tag_arg(self):
        """tag <tagname> stores the tag string."""
        parser = build_parser()
        ns = parser.parse_args(["tag", "python"])
        assert ns.command == "tag"
        assert ns.tag == "python"

    def test_search_parses_keyword(self):
        """search <keyword> stores the keyword string."""
        parser = build_parser()
        ns = parser.parse_args(["search", "hello"])
        assert ns.command == "search"
        assert ns.keyword == "hello"

    def test_parser_errors_without_command(self):
        """Omitting a command should raise SystemExit."""
        parser = build_parser()
        with pytest.raises(SystemExit):
            parser.parse_args([])


# ---------------------------------------------------------------------------
# cmd_add
# ---------------------------------------------------------------------------


class TestCmdAdd:
    """Tests for the add command handler."""

    def test_add_creates_note(self):
        """cmd_add stores a note and prints confirmation."""
        path = _fresh_path()
        try:
            rc = cmd_add(
                _args(file=path, text="Test note", tags="tag1,tag2")
            )
            assert rc == 0

            from note_storage import load_notes

            notes = load_notes(path)
            assert len(notes) == 1
            assert notes[0]["text"] == "Test note"
            assert notes[0]["tags"] == ["tag1", "tag2"]
            assert notes[0]["id"] == 1
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_add_no_tags(self):
        """add with no --tags stores an empty tags list."""
        path = _fresh_path()
        try:
            rc = cmd_add(_args(file=path, text="No tags", tags=""))
            assert rc == 0

            from note_storage import load_notes

            notes = load_notes(path)
            assert len(notes) == 1
            assert notes[0]["tags"] == []
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_add_increments_id(self):
        """Adding multiple notes via cmd_add increments IDs."""
        path = _fresh_path()
        try:
            cmd_add(_args(file=path, text="First", tags="a"))
            cmd_add(_args(file=path, text="Second", tags="b"))

            from note_storage import load_notes

            notes = load_notes(path)
            assert len(notes) == 2
            assert notes[0]["id"] == 1
            assert notes[1]["id"] == 2
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_add_missing_text_returns_error(self):
        """add with no text should print an error and return 1."""
        path = _fresh_path()
        try:
            old_stderr = sys.stderr
            sys.stderr = StringIO()
            try:
                rc = cmd_add(_args(file=path, text=None, tags=""))
                stderr = sys.stderr.getvalue()
            finally:
                sys.stderr = old_stderr

            assert rc == 1
            assert "Error: note text is required" in stderr
        finally:
            if os.path.exists(path):
                os.unlink(path)


# ---------------------------------------------------------------------------
# cmd_list
# ---------------------------------------------------------------------------


class TestCmdList:
    """Tests for the list command handler."""

    def test_list_empty(self):
        """Listing with no notes prints 'No notes found'."""
        path = _fresh_path()
        try:
            from note_storage import save_notes

            save_notes([], path)
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_list(_args(file=path))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "No notes found." in output
        finally:
            os.unlink(path)

    def test_list_with_notes(self):
        """Listing with notes shows each note's details."""
        path = _make_path(
            [
                {"id": 1, "text": "Alpha", "tags": ["personal"]},
                {"id": 2, "text": "Beta", "tags": ["work", "urgent"]},
                {"id": 3, "text": "Gamma", "tags": []},
            ]
        )
        try:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_list(_args(file=path))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "[1] Alpha" in output
            assert "[2] Beta" in output
            assert "[3] Gamma" in output
            assert "tags: personal" in output
            assert "tags: work, urgent" in output
        finally:
            os.unlink(path)

    def test_list_empty_file(self):
        """Listing a file with an empty JSON array prints 'No notes found'."""
        path = _make_path([])
        try:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_list(_args(file=path))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "No notes found." in output
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# cmd_tag
# ---------------------------------------------------------------------------


class TestCmdTag:
    """Tests for the tag command handler."""

    def test_tag_matches(self):
        """tag <tagname> shows notes with that tag."""
        path = _make_path(
            [
                {"id": 1, "text": "Python notes", "tags": ["python"]},
                {"id": 2, "text": "Shopping list", "tags": ["shopping"]},
                {"id": 3, "text": "Python tips", "tags": ["python"]},
            ]
        )
        try:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_tag(_args(file=path, tag="python"))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "[1] Python notes" in output
            assert "[3] Python tips" in output
            assert "Shopping list" not in output
        finally:
            os.unlink(path)

    def test_tag_no_match(self):
        """tag with a tag that has no matches prints 'No notes found'."""
        path = _make_path(
            [
                {"id": 1, "text": "Hello", "tags": ["greeting"]},
            ]
        )
        try:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_tag(_args(file=path, tag="nonexistent"))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "No notes found." in output
        finally:
            os.unlink(path)

    def test_tag_missing_arg_returns_error(self):
        """tag with no tag value should print an error and return 1."""
        old_stderr = sys.stderr
        sys.stderr = StringIO()
        try:
            rc = cmd_tag(_args(file="dummy.json", tag=None))
            stderr = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr

        assert rc == 1
        assert "Error: tag is required" in stderr


# ---------------------------------------------------------------------------
# cmd_search
# ---------------------------------------------------------------------------


class TestCmdSearch:
    """Tests for the search command handler."""

    def test_search_matches(self):
        """search <keyword> shows notes whose text contains the keyword."""
        path = _make_path(
            [
                {"id": 1, "text": "Buy groceries", "tags": []},
                {"id": 2, "text": "Meeting notes", "tags": []},
                {"id": 3, "text": "Groceries for camping", "tags": []},
            ]
        )
        try:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_search(_args(file=path, keyword="groceries"))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "[1] Buy groceries" in output
            assert "[3] Groceries for camping" in output
            assert "Meeting notes" not in output
        finally:
            os.unlink(path)

    def test_search_case_insensitive(self):
        """search is case-insensitive."""
        path = _make_path(
            [
                {"id": 1, "text": "Hello World", "tags": []},
                {"id": 2, "text": "goodbye world", "tags": []},
            ]
        )
        try:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_search(_args(file=path, keyword="WORLD"))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "[1] Hello World" in output
            assert "[2] goodbye world" in output
        finally:
            os.unlink(path)

    def test_search_no_match(self):
        """search with no matches prints 'No notes found'."""
        path = _make_path(
            [
                {"id": 1, "text": "Hello", "tags": []},
            ]
        )
        try:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = cmd_search(_args(file=path, keyword="zzzzz"))
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert rc == 0
            assert "No notes found." in output
        finally:
            os.unlink(path)

    def test_search_missing_keyword_returns_error(self):
        """search with no keyword should print an error and return 1."""
        old_stderr = sys.stderr
        sys.stderr = StringIO()
        try:
            rc = cmd_search(_args(file="dummy.json", keyword=None))
            stderr = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr

        assert rc == 1
        assert "Error: keyword is required" in stderr


# ---------------------------------------------------------------------------
# Integration tests via main()
# ---------------------------------------------------------------------------


class TestMain:
    """Integration tests for the main() entry point."""

    def test_main_add(self):
        """main() with 'add' command creates a note."""
        path = _fresh_path()
        try:
            output = _capture_main(
                ["--file", path, "add", "Integration test", "--tags", "test,cli"]
            )
            assert "Added note #1: Integration test" in output

            from note_storage import load_notes

            notes = load_notes(path)
            assert len(notes) == 1
            assert notes[0]["text"] == "Integration test"
            assert notes[0]["tags"] == ["test", "cli"]
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_main_list(self):
        """main() with 'list' command prints notes."""
        path = _make_path(
            [{"id": 1, "text": "Hello", "tags": ["greeting"]}]
        )
        try:
            output = _capture_main(["--file", path, "list"])
            assert "[1] Hello" in output
        finally:
            os.unlink(path)

    def test_main_tag(self):
        """main() with 'tag' command filters by tag."""
        path = _make_path(
            [
                {"id": 1, "text": "Python notes", "tags": ["python"]},
                {"id": 2, "text": "Shopping list", "tags": ["shopping"]},
            ]
        )
        try:
            output = _capture_main(["--file", path, "tag", "python"])
            assert "[1] Python notes" in output
            assert "Shopping list" not in output
        finally:
            os.unlink(path)

    def test_main_search(self):
        """main() with 'search' command finds by keyword."""
        path = _make_path(
            [
                {"id": 1, "text": "Buy groceries", "tags": []},
                {"id": 2, "text": "Meeting notes", "tags": []},
            ]
        )
        try:
            output = _capture_main(["--file", path, "search", "groceries"])
            assert "[1] Buy groceries" in output
            assert "Meeting notes" not in output
        finally:
            os.unlink(path)

    def test_main_unknown_command_shows_usage(self):
        """main() with an unknown command prints usage and returns 1."""
        old_stderr = sys.stderr
        sys.stderr = StringIO()
        try:
            with pytest.raises(SystemExit) as exc_info:
                main(["unknown"])
            stderr = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr

        assert exc_info.value.code == 2
        assert "invalid choice" in stderr or "unrecognized" in stderr

    def test_main_no_command_prints_usage(self):
        """main() with no command should print error and return non-zero."""
        old_stderr = sys.stderr
        sys.stderr = StringIO()
        try:
            with pytest.raises(SystemExit) as exc_info:
                main([])
            stderr = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr

        assert exc_info.value.code is not None  # argparse raises SystemExit