"""Unit tests for todo_cli.py CLI logic.

Tests focus on argument parsing, command routing, and the printed output
of each subcommand. File I/O is isolated using temporary files.
"""

import os
import sys
import tempfile
from io import StringIO

import pytest

from todo_cli import create_parser, main, run_add, run_done, run_filter, run_list

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


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


class TestCreateParser:
    """Tests for argument parser construction."""

    def test_parser_creates_default_file(self):
        """The default --file value should be 'tasks.json'."""
        parser = create_parser()
        ns = parser.parse_args(["list"])
        assert ns.file == "tasks.json"

    def test_parser_accepts_custom_file(self):
        """--file flag should override the default path."""
        parser = create_parser()
        ns = parser.parse_args(["--file", "mytasks.json", "list"])
        assert ns.file == "mytasks.json"

    def test_add_command_parses_title_and_priority(self):
        """add <title> <priority> stores title (str) and priority (int)."""
        parser = create_parser()
        ns = parser.parse_args(["add", "Buy milk", "3"])
        assert ns.command == "add"
        assert ns.title == "Buy milk"
        assert ns.priority == 3

    def test_list_command_no_arg(self):
        """list command takes no additional positional args."""
        parser = create_parser()
        ns = parser.parse_args(["list"])
        assert ns.command == "list"

    def test_done_command_parses_id(self):
        """done <id> stores id as int."""
        parser = create_parser()
        ns = parser.parse_args(["done", "5"])
        assert ns.command == "done"
        assert ns.id == 5

    def test_filter_status_done(self):
        """filter --status done sets the value to 'done'."""
        parser = create_parser()
        ns = parser.parse_args(["filter", "--status", "done"])
        assert ns.command == "filter"
        assert ns.status == "done"

    def test_filter_status_pending(self):
        """filter --status pending sets the value to 'pending'."""
        parser = create_parser()
        ns = parser.parse_args(["filter", "--status", "pending"])
        assert ns.command == "filter"
        assert ns.status == "pending"

    def test_filter_exact_priority(self):
        """filter --priority N sets the value as int."""
        parser = create_parser()
        ns = parser.parse_args(["filter", "--priority", "2"])
        assert ns.priority == 2

    def test_filter_priority_range(self):
        """filter --priority-min N --priority-max M sets both as ints."""
        parser = create_parser()
        ns = parser.parse_args(
            ["filter", "--priority-min", "1", "--priority-max", "5"]
        )
        assert ns.priority_min == 1
        assert ns.priority_max == 5

    def test_filter_priority_min_only(self):
        """filter --priority-min N without --priority-max is allowed."""
        parser = create_parser()
        ns = parser.parse_args(["filter", "--priority-min", "3"])
        assert ns.priority_min == 3
        assert ns.priority_max is None

    def test_filter_priority_max_only(self):
        """filter --priority-max N without --priority-min is allowed."""
        parser = create_parser()
        ns = parser.parse_args(["filter", "--priority-max", "7"])
        assert ns.priority_min is None
        assert ns.priority_max == 7

    def test_parser_prints_help_with_no_command(self, capsys):
        """Omitting a command should print usage and exit."""
        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args([])


# ---------------------------------------------------------------------------
# run_add
# ---------------------------------------------------------------------------


class TestRunAdd:
    """Tests for the add command handler."""

    def test_add_creates_task(self):
        """run_add should store a new task and print confirmation."""
        # Use mkstemp so the file is empty (doesn't exist from load_tasks' perspective)
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(path)  # Remove so load_tasks returns []

        try:
            args = type("Args", (), {"file": path, "title": "Test Task", "priority": 2})()
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                run_add(args)
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert "Added task #1: Test Task" in output

            # Verify file was created
            from todo_storage import load_tasks

            tasks = load_tasks(path)
            assert len(tasks) == 1
            assert tasks[0]["title"] == "Test Task"
            assert tasks[0]["priority"] == 2
            assert tasks[0]["done"] is False
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_add_increments_id(self):
        """Adding multiple tasks via CLI increments IDs correctly."""
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(path)

        try:
            args1 = type("Args", (), {"file": path, "title": "First", "priority": 1})()
            args2 = type("Args", (), {"file": path, "title": "Second", "priority": 2})()

            run_add(args1)
            run_add(args2)

            from todo_storage import load_tasks

            tasks = load_tasks(path)
            assert len(tasks) == 2
            assert tasks[0]["id"] == 1
            assert tasks[1]["id"] == 2
        finally:
            if os.path.exists(path):
                os.unlink(path)


# ---------------------------------------------------------------------------
# run_list
# ---------------------------------------------------------------------------


class TestRunList:
    """Tests for the list command handler."""

    def test_list_empty(self):
        """Listing with no tasks prints 'No tasks found'."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks([], path)
            args = type("Args", (), {"file": path})()
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                run_list(args)
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert "No tasks found." in output
        finally:
            os.unlink(path)

    def test_list_with_tasks(self):
        """Listing with tasks shows each task's details."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks(
                [
                    {"id": 1, "title": "Alpha", "priority": 1, "done": False},
                    {"id": 2, "title": "Beta", "priority": 2, "done": True},
                ],
                path,
            )
            args = type("Args", (), {"file": path})()
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                run_list(args)
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert "Alpha" in output
            assert "Beta" in output
            assert "priority: 1" in output
            assert "priority: 2" in output
            # pending shows ' ', done shows '✓'
            assert "[ ]" in output or "[ ]" in output
            assert "[✓]" in output or "[\u2713]" in output
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# run_done
# ---------------------------------------------------------------------------


class TestRunDone:
    """Tests for the done command handler."""

    def test_done_marks_task(self):
        """run_done marks an existing task and prints confirmation."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks(
                [{"id": 1, "title": "Test", "priority": 1, "done": False}],
                path,
            )
            args = type("Args", (), {"file": path, "id": 1})()
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                run_done(args)
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert "Task #1 marked as done." in output

            from todo_storage import load_tasks

            assert load_tasks(path)[0]["done"] is True
        finally:
            os.unlink(path)

    def test_done_nonexistent(self):
        """run_done on a missing task prints 'not found'."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks([], path)
            args = type("Args", (), {"file": path, "id": 99})()
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                run_done(args)
                output = sys.stdout.getvalue()
            finally:
                sys.stdout = old_stdout

            assert "Task #99 not found." in output
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# run_filter
# ---------------------------------------------------------------------------


class TestRunFilter:
    """Tests for the filter command handler."""

    @pytest.fixture
    def sample_path(self):
        """Create a temporary JSON file with sample tasks."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks(
                [
                    {"id": 1, "title": "Task A", "priority": 1, "done": True},
                    {"id": 2, "title": "Task B", "priority": 2, "done": False},
                    {"id": 3, "title": "Task C", "priority": 2, "done": True},
                    {"id": 4, "title": "Task D", "priority": 3, "done": False},
                ],
                path,
            )
            yield path
        finally:
            os.unlink(path)

    def _run(self, path: str, **kwargs) -> str:
        args = type("Args", (), {"file": path, **kwargs})()
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_filter(args)
            return sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout

    def test_filter_status_done(self, sample_path):
        """filter --status done shows only completed tasks."""
        output = self._run(sample_path, status="done", priority=None, priority_min=None, priority_max=None)
        assert "Task A" in output
        assert "Task C" in output
        assert "Task B" not in output
        assert "Task D" not in output

    def test_filter_status_pending(self, sample_path):
        """filter --status pending shows only incomplete tasks."""
        output = self._run(sample_path, status="pending", priority=None, priority_min=None, priority_max=None)
        assert "Task B" in output
        assert "Task D" in output
        assert "Task A" not in output
        assert "Task C" not in output

    def test_filter_exact_priority(self, sample_path):
        """filter --priority N shows only tasks with that priority."""
        output = self._run(sample_path, status=None, priority=2, priority_min=None, priority_max=None)
        assert "Task B" in output
        assert "Task C" in output
        assert "Task A" not in output
        assert "Task D" not in output

    def test_filter_priority_range(self, sample_path):
        """filter --priority-min N --priority-max M shows range."""
        output = self._run(sample_path, status=None, priority=None, priority_min=2, priority_max=3)
        assert "Task B" in output
        assert "Task C" in output
        assert "Task D" in output
        assert "Task A" not in output

    def test_filter_no_match(self, sample_path):
        """Filter with no matches prints 'No tasks found'."""
        output = self._run(sample_path, status=None, priority=99, priority_min=None, priority_max=None)
        assert "No tasks found." in output

    def test_filter_no_criteria_returns_all(self, sample_path):
        """filter with no flags returns all tasks."""
        output = self._run(sample_path, status=None, priority=None, priority_min=None, priority_max=None)
        assert "Task A" in output
        assert "Task B" in output
        assert "Task C" in output
        assert "Task D" in output


# ---------------------------------------------------------------------------
# main() integration
# ---------------------------------------------------------------------------


class TestMain:
    """Integration tests for the main() entry point."""

    def test_main_add(self):
        """main() with 'add' command creates a task."""
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(path)

        try:
            output = _capture_main(["--file", path, "add", "Integration", "5"])
            assert "Added task #1: Integration" in output

            from todo_storage import load_tasks

            tasks = load_tasks(path)
            assert len(tasks) == 1
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_main_list(self):
        """main() with 'list' command prints tasks."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks(
                [{"id": 1, "title": "Hello", "priority": 3, "done": False}],
                path,
            )
            output = _capture_main(["--file", path, "list"])
            assert "Hello" in output
        finally:
            os.unlink(path)

    def test_main_done(self):
        """main() with 'done' command marks a task done."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks(
                [{"id": 1, "title": "Hello", "priority": 1, "done": False}],
                path,
            )
            output = _capture_main(["--file", path, "done", "1"])
            assert "Task #1 marked as done." in output

            from todo_storage import load_tasks

            assert load_tasks(path)[0]["done"] is True
        finally:
            os.unlink(path)

    def test_main_filter(self):
        """main() with 'filter' command filters correctly."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            from todo_storage import save_tasks

            save_tasks(
                [
                    {"id": 1, "title": "High", "priority": 5, "done": False},
                    {"id": 2, "title": "Low", "priority": 1, "done": False},
                ],
                path,
            )
            output = _capture_main(
                ["--file", path, "filter", "--priority-min", "3"]
            )
            assert "High" in output
            assert "Low" not in output
        finally:
            os.unlink(path)