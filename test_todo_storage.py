"""Tests for todo_storage module."""

import json
import os
import tempfile

import pytest

from todo_storage import add_task, load_tasks, mark_done, save_tasks


class TestAddTask:
    """Tests for add_task function."""

    def test_add_task_to_empty_list(self):
        """Adding a task to an empty list returns a dict with id=1."""
        task = add_task([], "Buy groceries", 2)
        assert task["id"] == 1
        assert task["title"] == "Buy groceries"
        assert task["priority"] == 2
        assert task["done"] is False

    def test_add_task_increments_id(self):
        """IDs are sequential starting from 1."""
        tasks = []
        t1 = add_task(tasks, "first", 1)
        tasks.append(t1)
        t2 = add_task(tasks, "second", 2)
        tasks.append(t2)
        t3 = add_task(tasks, "third", 3)
        tasks.append(t3)
        assert tasks[0]["id"] == 1
        assert tasks[1]["id"] == 2
        assert tasks[2]["id"] == 3

    def test_add_task_with_non_sequential_existing_ids(self):
        """When tasks have non-sequential IDs, new ID is max+1."""
        tasks = [{"id": 5, "title": "existing", "priority": 1, "done": False}]
        task = add_task(tasks, "new", 3)
        assert task["id"] == 6

    def test_add_task_default_done_is_false(self):
        """A new task should have done=False by default."""
        task = add_task([], "test", 1)
        assert task["done"] is False

    def test_add_task_preserves_title(self):
        """The title should be stored exactly as provided."""
        title = "Very important task with special chars: ñ, ü, é"
        task = add_task([], title, 1)
        assert task["title"] == title

    def test_add_task_preserves_priority(self):
        """The priority should be stored exactly as provided."""
        task = add_task([], "test", 5)
        assert task["priority"] == 5


class TestMarkDone:
    """Tests for mark_done function."""

    def test_mark_done_returns_true_for_existing_task(self):
        """mark_done returns True when the task is found."""
        tasks = [{"id": 1, "title": "test", "priority": 1, "done": False}]
        result = mark_done(tasks, 1)
        assert result is True

    def test_mark_done_sets_done_to_true(self):
        """mark_done sets the done field to True."""
        tasks = [{"id": 1, "title": "test", "priority": 1, "done": False}]
        mark_done(tasks, 1)
        assert tasks[0]["done"] is True

    def test_mark_done_returns_false_for_nonexistent_task(self):
        """mark_done returns False when the task id is not found."""
        tasks = [{"id": 1, "title": "test", "priority": 1, "done": False}]
        result = mark_done(tasks, 999)
        assert result is False

    def test_mark_done_does_not_modify_other_tasks(self):
        """mark_done should not affect other tasks in the list."""
        tasks = [
            {"id": 1, "title": "first", "priority": 1, "done": False},
            {"id": 2, "title": "second", "priority": 2, "done": False},
        ]
        mark_done(tasks, 1)
        assert tasks[1]["done"] is False

    def test_mark_done_empty_list_returns_false(self):
        """mark_done on an empty list returns False."""
        result = mark_done([], 1)
        assert result is False


class TestSaveTasks:
    """Tests for save_tasks function."""

    def test_save_tasks_creates_file(self):
        """Saving tasks creates a JSON file with correct contents."""
        tasks = [
            {"id": 1, "title": "test", "priority": 1, "done": False},
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_tasks(tasks, filepath)
            assert os.path.exists(filepath)
            with open(filepath, encoding="utf-8") as f:
                data = json.load(f)
            assert data == tasks
        finally:
            os.unlink(filepath)

    def test_save_tasks_empty_list(self):
        """Saving an empty list creates a file with an empty array."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_tasks([], filepath)
            with open(filepath, encoding="utf-8") as f:
                data = json.load(f)
            assert data == []
        finally:
            os.unlink(filepath)


class TestLoadTasks:
    """Tests for load_tasks function."""

    def test_load_tasks_returns_list(self):
        """Loading a valid JSON file returns the task list."""
        tasks = [
            {"id": 1, "title": "test", "priority": 1, "done": False},
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(tasks, f)
            filepath = f.name

        try:
            loaded = load_tasks(filepath)
            assert loaded == tasks
        finally:
            os.unlink(filepath)

    def test_load_tasks_file_not_found(self):
        """Loading a non-existent file returns an empty list."""
        result = load_tasks("/tmp/nonexistent_todo_file_12345.json")
        assert result == []

    def test_load_tasks_empty_file(self):
        """Loading a file with an empty array returns an empty list."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump([], f)
            filepath = f.name

        try:
            loaded = load_tasks(filepath)
            assert loaded == []
        finally:
            os.unlink(filepath)

    def test_load_tasks_invalid_json(self):
        """Loading a file with invalid JSON raises an error."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            f.write("not valid json")
            filepath = f.name

        try:
            with pytest.raises(json.JSONDecodeError):
                load_tasks(filepath)
        finally:
            os.unlink(filepath)


class TestIntegration:
    """Integration tests for the todo_storage module."""

    def test_save_and_load_roundtrip(self):
        """Tasks saved and then loaded should be identical."""
        tasks = []
        t1 = add_task(tasks, "hello", 1)
        tasks.append(t1)
        t2 = add_task(tasks, "world", 2)
        tasks.append(t2)

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            save_tasks(tasks, filepath)
            loaded = load_tasks(filepath)
            assert loaded == tasks
        finally:
            os.unlink(filepath)

    def test_full_workflow(self):
        """End-to-end workflow: add, save, load, mark done, add more."""
        tasks = []
        t1 = add_task(tasks, "first task", 1)
        tasks.append(t1)
        t2 = add_task(tasks, "second task", 3)
        tasks.append(t2)

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            filepath = f.name

        try:
            # Save
            save_tasks(tasks, filepath)

            # Load
            loaded = load_tasks(filepath)
            assert len(loaded) == 2

            # Mark done
            result = mark_done(loaded, 1)
            assert result is True
            assert loaded[0]["done"] is True
            assert loaded[1]["done"] is False

            # Add more
            t3 = add_task(loaded, "third task", 2)
            loaded.append(t3)
            assert len(loaded) == 3
            assert loaded[2]["id"] == 3
            assert loaded[2]["title"] == "third task"
            assert loaded[2]["priority"] == 2
            assert loaded[2]["done"] is False
        finally:
            os.unlink(filepath)