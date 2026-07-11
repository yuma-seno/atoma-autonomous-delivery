"""End-to-end integration test for the memo CLI.

Calls ``python memo_cli.py`` as a subprocess and tests the full
add → list → search workflow against a temporary JSON file.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

CLI_SCRIPT = Path(__file__).resolve().parent / "memo_cli.py"


def _run(*args: str, filepath: str) -> subprocess.CompletedProcess:
    """Run memo_cli.py with ``--file`` and the given subcommand arguments."""
    cmd = [sys.executable, str(CLI_SCRIPT), "--file", filepath, *args]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=os.path.dirname(CLI_SCRIPT),
    )


class TestE2EMemoWorkflow:
    """End-to-end integration scenarios for the memo CLI."""

    @pytest.fixture(autouse=True)
    def _temp_file(self) -> None:
        """Create a temporary JSON file path for each test and clean it up."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            self.filepath = f.name
            self.tempdir = os.path.dirname(f.name)
        yield
        if os.path.exists(self.filepath):
            os.unlink(self.filepath)

    # ------------------------------------------------------------------
    # Scenario: add two memos, list them, search by keyword, empty result
    # ------------------------------------------------------------------

    def test_add_two_memos(self):
        """Add two memos and verify both succeed."""
        r1 = _run("add", "first memo", filepath=self.filepath)
        assert r1.returncode == 0, f"stderr: {r1.stderr}"
        assert "first memo" in r1.stdout

        r2 = _run("add", "second memo", filepath=self.filepath)
        assert r2.returncode == 0, f"stderr: {r2.stderr}"
        assert "second memo" in r2.stdout

    def test_list_shows_all_memos(self):
        """After adding two memos, list displays both."""
        _run("add", "first memo", filepath=self.filepath)
        _run("add", "second memo", filepath=self.filepath)

        result = _run("list", filepath=self.filepath)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert "first memo" in result.stdout
        assert "second memo" in result.stdout

    def test_search_finds_matching_memo(self):
        """Search with a keyword returns only the matching memo."""
        _run("add", "apple pie", filepath=self.filepath)
        _run("add", "banana bread", filepath=self.filepath)

        result = _run("search", "apple", filepath=self.filepath)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert "apple pie" in result.stdout
        assert "banana bread" not in result.stdout

    def test_search_nonexistent_keyword_returns_empty(self):
        """Search with a keyword that matches nothing shows a no-result message."""
        _run("add", "hello world", filepath=self.filepath)

        result = _run("search", "zzzzzz", filepath=self.filepath)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        # Should indicate no memos found
        assert "No memos found" in result.stdout

    # ------------------------------------------------------------------
    # Combined scenario: single test exercising the full workflow
    # ------------------------------------------------------------------

    def test_full_workflow(self):
        """Add → list → search → no-match in a single test."""
        # 1. Add two memos
        for text in ("first memo", "second memo"):
            r = _run("add", text, filepath=self.filepath)
            assert r.returncode == 0

        # 2. List — both memos are shown
        r = _run("list", filepath=self.filepath)
        assert r.returncode == 0
        assert "first memo" in r.stdout
        assert "second memo" in r.stdout

        # 3. Search — only the matching one
        r = _run("search", "first", filepath=self.filepath)
        assert r.returncode == 0
        assert "first memo" in r.stdout
        assert "second memo" not in r.stdout

        # 4. Search non-existent keyword — empty result
        r = _run("search", "nonexistent", filepath=self.filepath)
        assert r.returncode == 0
        assert "No memos found" in r.stdout