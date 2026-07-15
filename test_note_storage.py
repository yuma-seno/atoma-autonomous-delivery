"""Tests for note_storage module."""

import json
import os
import tempfile

import pytest

from note_storage import add_note, load_notes, save_notes


class TestAddNote:
    """Tests for add_note function."""

    def test_add_note_returns_dict(self):
        """add_note returns the newly created note dict."""
        notes = []
        result = add_note(notes, "hello", ["tag1"])
        assert isinstance(result, dict)
        assert result["text"] == "hello"
        assert result["tags"] == ["tag1"]
        assert result["id"] == 1

    def test_add_note_appends_to_list(self):
        """Adding a note mutates the list in place."""
        notes = []
        add_note(notes, "hello", ["tag1"])
        assert len(notes) == 1
        assert notes[0]["text"] == "hello"
        assert notes[0]["tags"] == ["tag1"]
        assert notes[0]["id"] == 1

    def test_add_note_auto_increments_id(self):
        """IDs are sequential starting from 1."""
        notes = []
        n1 = add_note(notes, "first", [])
        n2 = add_note(notes, "second", [])
        n3 = add_note(notes, "third", [])
        assert n1["id"] == 1
        assert n2["id"] == 2
        assert n3["id"] == 3
        assert notes[0]["id"] == 1
        assert notes[1]["id"] == 2
        assert notes[2]["id"] == 3

    def test_add_note_empty_tags(self):
        """Empty tags list is handled correctly."""
        notes = []
        result = add_note(notes, "no tags", [])
        assert result["tags"] == []

    def test_add_note_multiple_tags(self):
        """Multiple tags are stored correctly."""
        notes = []
        result = add_note(notes, "multi", ["a", "b", "c"])
        assert result["tags"] == ["a", "b", "c"]

    def test_add_note_id_from_existing(self):
        """When notes have non-sequential IDs, new ID is max+1."""
        notes = [{"id": 10, "text": "existing", "tags": []}]
        result = add_note(notes, "new", [])
        assert result["id"] == 11
        assert len(notes) == 2

    def test_add_note_preserves_existing_notes(self):
        """Existing notes are preserved when adding a new one."""
        notes = []
        add_note(notes, "first", ["a"])
        add_note(notes, "second", ["b"])
        assert len(notes) == 2
        assert notes[0]["text"] == "first"
        assert notes[1]["text"] == "second"


class TestSaveNotes:
    """Tests for save_notes function."""

    def test_save_notes_creates_file(self):
        """Saving notes creates a JSON file."""
        notes = [{"id": 1, "text": "test", "tags": ["t1"]}]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_notes(notes, filepath)
            assert os.path.exists(filepath)
            with open(filepath, encoding="utf-8") as f:
                data = json.load(f)
            assert data == notes
        finally:
            os.unlink(filepath)

    def test_save_notes_empty_list(self):
        """Saving an empty list creates a file with an empty array."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_notes([], filepath)
            with open(filepath, encoding="utf-8") as f:
                data = json.load(f)
            assert data == []
        finally:
            os.unlink(filepath)


class TestLoadNotes:
    """Tests for load_notes function."""

    def test_load_notes_returns_list(self):
        """Loading a valid JSON file returns the notes list."""
        notes = [{"id": 1, "text": "test", "tags": ["t1"]}]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(notes, f)
            filepath = f.name

        try:
            loaded = load_notes(filepath)
            assert loaded == notes
        finally:
            os.unlink(filepath)

    def test_load_notes_file_not_found(self):
        """Loading a non-existent file returns an empty list."""
        result = load_notes("/tmp/nonexistent_notes_file_12345.json")
        assert result == []

    def test_load_notes_empty_file(self):
        """Loading a file with an empty array returns an empty list."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump([], f)
            filepath = f.name

        try:
            loaded = load_notes(filepath)
            assert loaded == []
        finally:
            os.unlink(filepath)

    def test_load_notes_invalid_json(self):
        """Loading a file with invalid JSON raises an error."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            f.write("not valid json")
            filepath = f.name

        try:
            with pytest.raises(json.JSONDecodeError):
                load_notes(filepath)
        finally:
            os.unlink(filepath)


class TestIntegration:
    """Integration tests for the note_storage module."""

    def test_save_and_load_roundtrip(self):
        """Notes saved and then loaded should be identical."""
        notes = []
        add_note(notes, "hello", ["greeting"])
        add_note(notes, "world", ["farewell"])

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_notes(notes, filepath)
            loaded = load_notes(filepath)
            assert loaded == notes
        finally:
            os.unlink(filepath)

    def test_full_workflow(self):
        """End-to-end workflow: add, save, load, add more."""
        notes = []
        add_note(notes, "first note", ["a"])
        add_note(notes, "second note", ["b"])

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_notes(notes, filepath)

            loaded = load_notes(filepath)
            assert len(loaded) == 2

            add_note(loaded, "third note", ["c"])
            assert len(loaded) == 3
            assert loaded[2]["id"] == 3
            assert loaded[2]["text"] == "third note"
            assert loaded[2]["tags"] == ["c"]
        finally:
            os.unlink(filepath)