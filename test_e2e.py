"""End-to-end integration tests for note_storage, note_query, and note_cli.

Tests combine all three modules in realistic workflows:
  1. API-level: add_note → save_notes → load_notes → find_by_tag / find_by_keyword
  2. CLI-level: add → list → tag → search via main()
  3. File cleanup via tempfile / pytest fixtures
"""

import json
import os
import sys
import tempfile
from io import StringIO

import pytest

from note_cli import main
from note_query import find_by_keyword, find_by_tag
from note_storage import add_note, load_notes, save_notes


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def temp_json_path():
    """Yield a temporary JSON file path and guarantee cleanup after the test."""
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    os.unlink(path)  # remove so the file doesn't exist yet
    yield path
    if os.path.exists(path):
        os.unlink(path)


@pytest.fixture
def pre_populated_path():
    """Yield a path pre-populated with sample notes, then clean up."""
    notes = [
        {"id": 1, "text": "Buy groceries for camping", "tags": ["personal", "shopping"]},
        {"id": 2, "text": "Python project meeting notes", "tags": ["work", "python"]},
        {"id": 3, "text": "Practice Python exercises", "tags": ["personal", "python"]},
    ]
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(notes, f)
    yield path
    if os.path.exists(path):
        os.unlink(path)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _capture_main(argv: list[str]) -> tuple[str, str]:
    """Run main() with the given argv and return (stdout, stderr)."""
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = StringIO()
    sys.stderr = StringIO()
    try:
        main(argv)
        return sys.stdout.getvalue(), sys.stderr.getvalue()
    except SystemExit as e:
        return sys.stdout.getvalue(), sys.stderr.getvalue()
    finally:
        sys.stdout, sys.stderr = old_stdout, old_stderr


# ===================================================================
# SCENARIO 1: API-level end-to-end flow
# ===================================================================


class TestAPIE2EFlow:
    """Exercise the full round-trip through the public API of all three modules."""

    def test_add_save_load_search(self, temp_json_path):
        """Add notes, save, reload, and search by tag and keyword."""
        path = temp_json_path

        # --- Phase 1: Add notes ---
        notes = []
        n1 = add_note(notes, "Buy groceries", ["personal", "shopping"])
        n2 = add_note(notes, "Python project meeting", ["work", "python"])
        n3 = add_note(notes, "Practice Python exercises", ["personal", "python"])

        assert len(notes) == 3
        assert n1["id"] == 1
        assert n2["id"] == 2
        assert n3["id"] == 3

        # --- Phase 2: Save to file ---
        save_notes(notes, path)
        assert os.path.exists(path)

        # --- Phase 3: Load from file ---
        loaded = load_notes(path)
        assert len(loaded) == 3
        assert loaded == notes

        # --- Phase 4: Search by tag ---
        python_notes = find_by_tag(loaded, "python")
        assert len(python_notes) == 2
        python_ids = {n["id"] for n in python_notes}
        assert python_ids == {2, 3}

        personal_notes = find_by_tag(loaded, "personal")
        assert len(personal_notes) == 2
        assert {n["id"] for n in personal_notes} == {1, 3}

        shopping_notes = find_by_tag(loaded, "shopping")
        assert len(shopping_notes) == 1
        assert shopping_notes[0]["id"] == 1

        work_notes = find_by_tag(loaded, "work")
        assert len(work_notes) == 1
        assert work_notes[0]["id"] == 2

        # --- Phase 5: Search by keyword ---
        python_kw = find_by_keyword(loaded, "python")
        assert len(python_kw) == 2
        assert {n["id"] for n in python_kw} == {2, 3}

        groceries_kw = find_by_keyword(loaded, "groceries")
        assert len(groceries_kw) == 1
        assert groceries_kw[0]["id"] == 1

        # Case-insensitive keyword search
        case_insensitive = find_by_keyword(loaded, "PYTHON")
        assert len(case_insensitive) == 2

        # Keyword with no matches
        no_match = find_by_keyword(loaded, "nonexistent")
        assert no_match == []

    def test_add_save_load_append_and_search_again(self, temp_json_path):
        """Load existing notes, append a new one, re-save, re-load, and search."""
        path = temp_json_path

        # Initial notes
        notes = []
        add_note(notes, "First note", ["alpha"])
        add_note(notes, "Second note", ["beta"])
        save_notes(notes, path)

        # Re-load and append
        loaded = load_notes(path)
        assert len(loaded) == 2

        add_note(loaded, "Third note", ["alpha", "gamma"])
        assert len(loaded) == 3
        assert loaded[2]["id"] == 3
        assert loaded[2]["text"] == "Third note"
        assert loaded[2]["tags"] == ["alpha", "gamma"]

        # Re-save and re-load
        save_notes(loaded, path)
        reloaded = load_notes(path)
        assert len(reloaded) == 3
        assert reloaded == loaded

        # Search across all three
        alpha_notes = find_by_tag(reloaded, "alpha")
        assert len(alpha_notes) == 2  # First and Third
        assert {n["id"] for n in alpha_notes} == {1, 3}

        gamma_notes = find_by_tag(reloaded, "gamma")
        assert len(gamma_notes) == 1
        assert gamma_notes[0]["id"] == 3

    def test_tags_roundtrip(self, temp_json_path):
        """Add notes with various tag configurations, save, load, verify."""
        path = temp_json_path
        notes = []
        add_note(notes, "No tags", [])
        add_note(notes, "Single tag", ["urgent"])
        add_note(notes, "Multiple tags", ["a", "b", "c"])
        add_note(notes, "Empty string tag", [""])

        save_notes(notes, path)
        loaded = load_notes(path)

        assert loaded[0]["tags"] == []
        assert loaded[1]["tags"] == ["urgent"]
        assert loaded[2]["tags"] == ["a", "b", "c"]
        assert loaded[3]["tags"] == [""]

    def test_empty_notes_list(self, temp_json_path):
        """Save and load an empty notes list, then add and search."""
        path = temp_json_path
        notes = []
        save_notes(notes, path)

        loaded = load_notes(path)
        assert loaded == []

        # Add to empty list
        add_note(loaded, "First after empty", ["new"])
        assert len(loaded) == 1
        assert loaded[0]["id"] == 1

        save_notes(loaded, path)
        reloaded = load_notes(path)
        assert len(reloaded) == 1

        new_notes = find_by_tag(reloaded, "new")
        assert len(new_notes) == 1

    def test_multiple_files_independent(self):
        """Two separate temp files should not interfere with each other."""
        fd1, path1 = tempfile.mkstemp(suffix=".json")
        fd2, path2 = tempfile.mkstemp(suffix=".json")
        os.close(fd1)
        os.close(fd2)
        # Remove so they start empty
        os.unlink(path1)
        os.unlink(path2)

        try:
            notes1 = []
            notes2 = []
            add_note(notes1, "File 1 note", ["file1"])
            add_note(notes2, "File 2 note", ["file2"])
            save_notes(notes1, path1)
            save_notes(notes2, path2)

            loaded1 = load_notes(path1)
            loaded2 = load_notes(path2)

            assert len(loaded1) == 1
            assert loaded1[0]["text"] == "File 1 note"
            assert len(loaded2) == 1
            assert loaded2[0]["text"] == "File 2 note"

            assert find_by_tag(loaded1, "file2") == []
            assert find_by_tag(loaded2, "file1") == []
        finally:
            for p in (path1, path2):
                if os.path.exists(p):
                    os.unlink(p)


# ===================================================================
# SCENARIO 2: CLI-level end-to-end flow
# ===================================================================


class TestCLIE2EFlow:
    """Exercise the full CLI workflow via main() — add, list, tag, search."""

    def test_cli_full_workflow(self, temp_json_path):
        """CLI: add notes → list → tag → search."""
        path = temp_json_path

        # --- add two notes ---
        stdout, stderr = _capture_main(
            ["--file", path, "add", "Buy groceries", "--tags", "personal,shopping"]
        )
        assert "Added note #1" in stdout
        assert stderr == ""

        stdout, stderr = _capture_main(
            ["--file", path, "add", "Python project meeting", "--tags", "work,python"]
        )
        assert "Added note #2" in stdout
        assert stderr == ""

        stdout, stderr = _capture_main(
            ["--file", path, "add", "Practice Python exercises", "--tags", "personal,python"]
        )
        assert "Added note #3" in stdout
        assert stderr == ""

        # --- list all notes ---
        stdout, stderr = _capture_main(["--file", path, "list"])
        assert stderr == ""
        assert "[1] Buy groceries" in stdout
        assert "[2] Python project meeting" in stdout
        assert "[3] Practice Python exercises" in stdout
        # Verify tags are displayed
        assert "tags: personal, shopping" in stdout
        assert "tags: work, python" in stdout
        assert "tags: personal, python" in stdout

        # --- tag: filter by "python" ---
        stdout, stderr = _capture_main(["--file", path, "tag", "python"])
        assert stderr == ""
        assert "[2] Python project meeting" in stdout
        assert "[3] Practice Python exercises" in stdout
        assert "[1] Buy groceries" not in stdout

        # --- tag: filter by "personal" ---
        stdout, stderr = _capture_main(["--file", path, "tag", "personal"])
        assert stderr == ""
        assert "[1] Buy groceries" in stdout
        assert "[3] Practice Python exercises" in stdout
        assert "[2] Python project meeting" not in stdout

        # --- tag: filter by non-existent tag ---
        stdout, stderr = _capture_main(["--file", path, "tag", "nonexistent"])
        assert stderr == ""
        assert "No notes found." in stdout

        # --- search: keyword "groceries" ---
        stdout, stderr = _capture_main(["--file", path, "search", "groceries"])
        assert stderr == ""
        assert "[1] Buy groceries" in stdout
        assert "[2] Python project meeting" not in stdout
        assert "[3] Practice Python exercises" not in stdout

        # --- search: keyword "python" (case-insensitive) ---
        stdout, stderr = _capture_main(["--file", path, "search", "PYTHON"])
        assert stderr == ""
        assert "[2] Python project meeting" in stdout
        assert "[3] Practice Python exercises" in stdout
        assert "[1] Buy groceries" not in stdout

        # --- search: keyword with no matches ---
        stdout, stderr = _capture_main(["--file", path, "search", "zzzzz"])
        assert stderr == ""
        assert "No notes found." in stdout

    def test_cli_add_no_tags(self, temp_json_path):
        """CLI add without --tags works and stores an empty tags list."""
        path = temp_json_path
        stdout, stderr = _capture_main(["--file", path, "add", "Untagged note"])
        assert "Added note #1" in stdout
        assert stderr == ""

        # Verify via list
        stdout, stderr = _capture_main(["--file", path, "list"])
        assert "[1] Untagged note" in stdout
        # Should not show "tags:" for empty tags
        assert "tags:" not in stdout

    def test_cli_add_missing_text(self, temp_json_path):
        """CLI add with no text shows an error."""
        path = temp_json_path
        stdout, stderr = _capture_main(["--file", path, "add"])
        # Note: argparse will treat missing text differently depending on nargs="?"
        # The text defaults to None, and cmd_add checks for it.
        # We just verify the command doesn't crash and the file stays empty.
        loaded = load_notes(path)
        assert loaded == []

    def test_cli_incremental_add(self, temp_json_path):
        """Multiple CLI add commands increment IDs correctly."""
        path = temp_json_path

        _capture_main(["--file", path, "add", "First"])
        _capture_main(["--file", path, "add", "Second"])
        _capture_main(["--file", path, "add", "Third"])

        stdout, stderr = _capture_main(["--file", path, "list"])
        assert "[1] First" in stdout
        assert "[2] Second" in stdout
        assert "[3] Third" in stdout

    def test_cli_list_empty(self, temp_json_path):
        """CLI list on a non-existent file prints 'No notes found'."""
        path = temp_json_path  # fixture ensures the file does not exist yet
        stdout, stderr = _capture_main(["--file", path, "list"])
        assert stderr == ""
        assert "No notes found." in stdout

    def test_cli_tag_missing_arg(self, temp_json_path):
        """CLI tag with no tag argument shows an error."""
        path = temp_json_path
        # argparse with nargs="?" means tag will be None
        stdout, stderr = _capture_main(["--file", path, "tag"])
        assert "Error: tag is required" in stderr

    def test_cli_search_missing_keyword(self, temp_json_path):
        """CLI search with no keyword shows an error."""
        path = temp_json_path
        stdout, stderr = _capture_main(["--file", path, "search"])
        assert "Error: keyword is required" in stderr


# ===================================================================
# SCENARIO 3: Cross-module edge cases
# ===================================================================


class TestCrossModuleEdgeCases:
    """Test edge cases that span multiple modules."""

    def test_notes_with_unicode(self, temp_json_path):
        """Unicode text survives the full round-trip and search."""
        path = temp_json_path
        notes = []
        add_note(notes, "日本語メモ", ["japanese"])
        add_note(notes, "café au lait", ["food", "french"])
        add_note(notes, "Mémo avec accents", ["french"])

        save_notes(notes, path)
        loaded = load_notes(path)

        assert loaded[0]["text"] == "日本語メモ"
        assert loaded[1]["text"] == "café au lait"

        # Search by keyword with unicode
        results = find_by_keyword(loaded, "café")
        assert len(results) == 1
        assert results[0]["id"] == 2

        results = find_by_keyword(loaded, "日本語")
        assert len(results) == 1
        assert results[0]["id"] == 1

        # CLI list
        stdout, stderr = _capture_main(["--file", path, "list"])
        assert "日本語メモ" in stdout
        assert "café au lait" in stdout
        assert "Mémo avec accents" in stdout

    def test_notes_with_special_characters_in_tags(self, temp_json_path):
        """Tags with special characters survive round-trip."""
        path = temp_json_path
        notes = []
        add_note(notes, "Note A", ["tag-with-dashes"])
        add_note(notes, "Note B", ["tag.with.dots"])
        add_note(notes, "Note C", ["tag_underscore"])

        save_notes(notes, path)
        loaded = load_notes(path)

        assert find_by_tag(loaded, "tag-with-dashes")[0]["id"] == 1
        assert find_by_tag(loaded, "tag.with.dots")[0]["id"] == 2
        assert find_by_tag(loaded, "tag_underscore")[0]["id"] == 3

    def test_large_number_of_notes(self, temp_json_path):
        """A larger set of notes (50 items) survives save/load and search."""
        path = temp_json_path
        notes = []
        for i in range(50):
            add_note(notes, f"Note number {i}", ["demo"])

        assert len(notes) == 50
        save_notes(notes, path)

        loaded = load_notes(path)
        assert len(loaded) == 50

        # All have sequential IDs
        for i, note in enumerate(loaded):
            assert note["id"] == i + 1

        # Search by tag
        demo_notes = find_by_tag(loaded, "demo")
        assert len(demo_notes) == 50

        # Search by keyword (partial match on "number 3")
        matches = find_by_keyword(loaded, "number 3")
        # "number 3" matches "number 30", "number 31"... "number 39", plus "number 3"
        # Actually: "Note number 3" matches "number 3"? Let's check: "number 3" is in "Note number 30"?
        # "Note number 30" contains "number 3" as a substring. So indices 3, 30-39 match.
        # That's 1 + 10 = 11 matches.
        assert len(matches) == 11

    def test_pre_populated_file_search(self, pre_populated_path):
        """Search operations on a pre-populated file work correctly."""
        path = pre_populated_path

        # CLI list
        stdout, stderr = _capture_main(["--file", path, "list"])
        assert "[1] Buy groceries for camping" in stdout
        assert "[2] Python project meeting notes" in stdout
        assert "[3] Practice Python exercises" in stdout

        # CLI tag
        stdout, stderr = _capture_main(["--file", path, "tag", "python"])
        assert "[2] Python project meeting notes" in stdout
        assert "[3] Practice Python exercises" in stdout
        assert "[1] Buy groceries for camping" not in stdout

        # CLI search
        stdout, stderr = _capture_main(["--file", path, "search", "camping"])
        assert "[1] Buy groceries for camping" in stdout
        assert "[2] Python project meeting notes" not in stdout
        assert "[3] Practice Python exercises" not in stdout

    def test_load_corrupt_file_graceful(self):
        """Loading a corrupt JSON file through the CLI does not crash."""
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        with open(path, "w", encoding="utf-8") as f:
            f.write("not valid json at all")

        try:
            # The CLI's _load_or_empty returns [] on JSONDecodeError
            stdout, stderr = _capture_main(["--file", path, "list"])
            assert "No notes found." in stdout
        finally:
            os.unlink(path)