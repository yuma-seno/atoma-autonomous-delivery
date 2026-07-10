"""Tests for memo_cli module."""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest


CLI_SCRIPT = Path(__file__).resolve().parent / "memo_cli.py"


def run_cli(*args, filepath=None):
    """Run memo_cli.py with the given args, optionally overriding the default file path.

    Returns a subprocess.CompletedProcess.
    """
    cmd = [sys.executable, str(CLI_SCRIPT)]
    if filepath is not None:
        cmd.extend(["--file", filepath])
    cmd.extend(args)
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=os.path.dirname(CLI_SCRIPT),
    )


class TestAddCommand:
    """Tests for the ``add`` subcommand."""

    def test_add_memo_success(self):
        """Adding a memo exits with code 0 and prints a success message."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            result = run_cli("add", "Hello, world!", filepath=filepath)
            assert result.returncode == 0
            assert "Added" in result.stdout or "追加" in result.stdout or "memo" in result.stdout.lower()
            # Verify the file was created and contains the memo
            content = Path(filepath).read_text(encoding="utf-8")
            assert "Hello, world!" in content
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)

    def test_add_memo_empty_text(self):
        """Adding an empty memo text exits with code 1."""
        result = run_cli("add", "")
        assert result.returncode == 1

    def test_add_memo_persists_to_file(self):
        """Memos added in separate invocations are both persisted."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            run_cli("add", "first note", filepath=filepath)
            run_cli("add", "second note", filepath=filepath)

            result = run_cli("list", filepath=filepath)
            assert result.returncode == 0
            assert "first note" in result.stdout
            assert "second note" in result.stdout
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)

    def test_add_memo_with_japanese(self):
        """Adding a memo with Japanese text works correctly."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            result = run_cli("add", "メモ内容", filepath=filepath)
            assert result.returncode == 0
            content = Path(filepath).read_text(encoding="utf-8")
            assert "メモ内容" in content
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)


class TestListCommand:
    """Tests for the ``list`` subcommand."""

    def test_list_empty(self):
        """Listing when no memos exist shows an appropriate message."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            # Ensure empty file
            Path(filepath).write_text("[]", encoding="utf-8")
            result = run_cli("list", filepath=filepath)
            assert result.returncode == 0
            # Should show some "no memos" or "empty" message
            assert result.stdout.strip()
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)

    def test_list_with_memos(self):
        """Listing memos shows all stored memos."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            run_cli("add", "alpha", filepath=filepath)
            run_cli("add", "beta", filepath=filepath)
            run_cli("add", "gamma", filepath=filepath)

            result = run_cli("list", filepath=filepath)
            assert result.returncode == 0
            assert "alpha" in result.stdout
            assert "beta" in result.stdout
            assert "gamma" in result.stdout
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)

    def test_list_no_file_exists(self):
        """Listing when the file doesn't exist shows an empty state gracefully."""
        filepath = "/tmp/nonexistent_memo_cli_test.json"
        # Ensure it doesn't exist
        if os.path.exists(filepath):
            os.unlink(filepath)
        try:
            result = run_cli("list", filepath=filepath)
            assert result.returncode == 0
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)


class TestSearchCommand:
    """Tests for the ``search`` subcommand."""

    def test_search_finds_matching(self):
        """Searching for a keyword shows matching memos."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            run_cli("add", "apple pie", filepath=filepath)
            run_cli("add", "banana bread", filepath=filepath)
            run_cli("add", "cherry tart", filepath=filepath)

            result = run_cli("search", "apple", filepath=filepath)
            assert result.returncode == 0
            assert "apple pie" in result.stdout
            assert "banana bread" not in result.stdout
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)

    def test_search_case_insensitive(self):
        """Search is case-insensitive."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            run_cli("add", "Hello World", filepath=filepath)
            result = run_cli("search", "hello", filepath=filepath)
            assert result.returncode == 0
            assert "Hello World" in result.stdout
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)

    def test_search_no_match(self):
        """Searching with no matches shows an appropriate message."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            run_cli("add", "something", filepath=filepath)
            result = run_cli("search", "zzzzz", filepath=filepath)
            assert result.returncode == 0
            assert result.stdout.strip()
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)

    def test_search_empty_keyword(self):
        """Searching with an empty keyword returns all memos."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            filepath = f.name
        try:
            run_cli("add", "note one", filepath=filepath)
            run_cli("add", "note two", filepath=filepath)
            result = run_cli("search", "", filepath=filepath)
            assert result.returncode == 0
            assert "note one" in result.stdout
            assert "note two" in result.stdout
        finally:
            if os.path.exists(filepath):
                os.unlink(filepath)


class TestErrorHandling:
    """Tests for error cases."""

    def test_no_subcommand(self):
        """Running without a subcommand prints usage and exits with code 2."""
        result = run_cli()
        assert result.returncode == 2

    def test_invalid_subcommand(self):
        """Running with an invalid subcommand exits with code 2."""
        result = run_cli("invalid_cmd")
        assert result.returncode == 2

    def test_add_without_text(self):
        """Running 'add' without text argument exits with code 1."""
        result = run_cli("add")
        assert result.returncode == 1