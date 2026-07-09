"""Tests for memo_storage module."""

import json
import os
import tempfile
from datetime import datetime

import pytest

from memo_storage import add_memo, load_memos, save_memos


class TestAddMemo:
    """Tests for add_memo function."""

    def test_add_memo_to_empty_list(self):
        """Adding a memo to an empty list returns a list with one memo."""
        result = add_memo([], "Hello")
        assert len(result) == 1
        assert result[0]["text"] == "Hello"
        assert result[0]["id"] == 1
        assert "created_at" in result[0]

    def test_add_memo_returns_new_list(self):
        """add_memo returns a new list (does not mutate the input)."""
        original = []
        result = add_memo(original, "Hello")
        assert result is not original

    def test_add_memo_increments_id(self):
        """IDs are sequential starting from 1."""
        memos = add_memo([], "first")
        memos = add_memo(memos, "second")
        memos = add_memo(memos, "third")
        assert memos[0]["id"] == 1
        assert memos[1]["id"] == 2
        assert memos[2]["id"] == 3

    def test_add_memo_preserves_existing_memos(self):
        """Existing memos are preserved when adding a new one."""
        memos = add_memo([], "first")
        memos = add_memo(memos, "second")
        assert len(memos) == 2
        assert memos[0]["text"] == "first"
        assert memos[1]["text"] == "second"

    def test_add_memo_created_at_format(self):
        """created_at should be an ISO-format datetime string."""
        result = add_memo([], "test")
        created_at = result[0]["created_at"]
        # Verify it's a valid ISO datetime string
        datetime.fromisoformat(created_at)

    def test_add_memo_with_existing_ids(self):
        """When memos have non-sequential IDs, new ID is max+1."""
        memos = [{"id": 5, "text": "existing", "created_at": "2024-01-01T00:00:00"}]
        result = add_memo(memos, "new")
        assert result[1]["id"] == 6


class TestSaveMemos:
    """Tests for save_memos function."""

    def test_save_memos_creates_file(self):
        """Saving memos creates a JSON file."""
        memos = [{"id": 1, "text": "test", "created_at": "2024-01-01T00:00:00"}]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_memos(memos, filepath)
            assert os.path.exists(filepath)
            with open(filepath, encoding="utf-8") as f:
                data = json.load(f)
            assert data == memos
        finally:
            os.unlink(filepath)

    def test_save_memos_empty_list(self):
        """Saving an empty list creates a file with an empty array."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_memos([], filepath)
            with open(filepath, encoding="utf-8") as f:
                data = json.load(f)
            assert data == []
        finally:
            os.unlink(filepath)


class TestLoadMemos:
    """Tests for load_memos function."""

    def test_load_memos_returns_list(self):
        """Loading a valid JSON file returns the memo list."""
        memos = [
            {"id": 1, "text": "test", "created_at": "2024-01-01T00:00:00"}
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(memos, f)
            filepath = f.name

        try:
            loaded = load_memos(filepath)
            assert loaded == memos
        finally:
            os.unlink(filepath)

    def test_load_memos_file_not_found(self):
        """Loading a non-existent file returns an empty list."""
        result = load_memos("/tmp/nonexistent_memo_file_12345.json")
        assert result == []

    def test_load_memos_empty_file(self):
        """Loading a file with an empty array returns an empty list."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump([], f)
            filepath = f.name

        try:
            loaded = load_memos(filepath)
            assert loaded == []
        finally:
            os.unlink(filepath)

    def test_load_memos_invalid_json(self):
        """Loading a file with invalid JSON raises an error or returns empty."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            f.write("not valid json")
            filepath = f.name

        try:
            with pytest.raises(json.JSONDecodeError):
                load_memos(filepath)
        finally:
            os.unlink(filepath)


class TestIntegration:
    """Integration tests for the memo_storage module."""

    def test_save_and_load_roundtrip(self):
        """Memos saved and then loaded should be identical."""
        original = add_memo([], "hello")
        original = add_memo(original, "world")

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_memos(original, filepath)
            loaded = load_memos(filepath)
            assert loaded == original
        finally:
            os.unlink(filepath)

    def test_full_workflow(self):
        """End-to-end workflow: add, save, load, add more."""
        memos = []
        memos = add_memo(memos, "first note")
        memos = add_memo(memos, "second note")

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_memos(memos, filepath)

            loaded = load_memos(filepath)
            assert len(loaded) == 2

            loaded = add_memo(loaded, "third note")
            assert len(loaded) == 3
            assert loaded[2]["id"] == 3
            assert loaded[2]["text"] == "third note"
        finally:
            os.unlink(filepath)