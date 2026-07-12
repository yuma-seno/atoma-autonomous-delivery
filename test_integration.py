"""Integration tests for the ToDo CLI.

Invokes the CLI as a subprocess (``python todo_cli.py …``) in a temporary
directory so that file‑based storage is fully isolated.  Every test cleans
up after itself.
"""

import os
import subprocess
import sys
import tempfile

import pytest

# Path to the CLI script (same directory as this test file).
CLI_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "todo_cli.py")
PYTHON = sys.executable


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run(*args: str, cwd: str) -> subprocess.CompletedProcess:
    """Run ``python todo_cli.py <args>`` inside *cwd* and return the result."""
    return subprocess.run(
        [PYTHON, CLI_PATH, *args],
        capture_output=True,
        text=True,
        cwd=cwd,
    )


def _run_with_file(*args: str, cwd: str, filename: str = "tasks.json") -> subprocess.CompletedProcess:
    """Run ``python todo_cli.py --file <filename> <args>`` inside *cwd*."""
    return _run("--file", filename, *args, cwd=cwd)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def temp_dir() -> str:
    """Provide a temporary directory that is automatically cleaned up."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


# ---------------------------------------------------------------------------
# Integration tests – end‑to‑end workflow
# ---------------------------------------------------------------------------


class TestFullWorkflow:
    """Exercise the complete user workflow through the real CLI subprocess."""

    # -------------------------------------------------- Steps 1‑3: Add tasks
    def test_add_task_priority_1(self, temp_dir: str):
        """Add a task with priority 1 → confirms output."""
        result = _run_with_file("add", "Write report", "1", cwd=temp_dir)

        assert result.returncode == 0, f"CLI failed:\n{result.stderr}"
        assert "Added task #1: Write report" in result.stdout

    def test_add_task_priority_2(self, temp_dir: str):
        """Add a task with priority 2 → confirms output."""
        result = _run_with_file("add", "Review code", "2", cwd=temp_dir)

        assert result.returncode == 0
        assert "Added task #1: Review code" in result.stdout

    def test_add_task_priority_3(self, temp_dir: str):
        """Add a task with priority 3 → confirms output."""
        result = _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)

        assert result.returncode == 0
        assert "Added task #1: Deploy to staging" in result.stdout

    # ------------------------------------------ Step 4: List → 3 tasks shown
    def test_list_after_three_adds(self, temp_dir: str):
        """List all tasks after adding three → 3 tasks shown."""
        _run_with_file("add", "Write report", "1", cwd=temp_dir)
        _run_with_file("add", "Review code", "2", cwd=temp_dir)
        _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)

        result = _run_with_file("list", cwd=temp_dir)

        assert result.returncode == 0
        # All three titles must appear
        assert "Write report" in result.stdout
        assert "Review code" in result.stdout
        assert "Deploy to staging" in result.stdout
        # And exactly three rows (no extra task lines)
        lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
        assert len(lines) == 3

    # ------------------------------------------------ Step 5: Mark id=1 done
    def test_mark_done_id1(self, temp_dir: str):
        """Mark task id=1 as done → confirms."""
        _run_with_file("add", "Write report", "1", cwd=temp_dir)
        _run_with_file("add", "Review code", "2", cwd=temp_dir)
        _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)

        result = _run_with_file("done", "1", cwd=temp_dir)

        assert result.returncode == 0
        assert "Task #1 marked as done." in result.stdout

    # ------------------------------- Step 6: List → task 1 done, others pending
    def test_list_after_mark_done(self, temp_dir: str):
        """List after marking id=1 done → task 1 done, others pending."""
        _run_with_file("add", "Write report", "1", cwd=temp_dir)
        _run_with_file("add", "Review code", "2", cwd=temp_dir)
        _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)
        _run_with_file("done", "1", cwd=temp_dir)

        result = _run_with_file("list", cwd=temp_dir)

        assert result.returncode == 0
        # Task 1 (Write report) should be marked ✓
        assert "[✓]" in result.stdout or "[\u2713]" in result.stdout
        # Task 2 & 3 are pending (no checkmark)
        # The pending indicator is "[ ]" (space inside brackets)
        assert "[ ]  2. Review code" in result.stdout or "[ ]" in result.stdout

    # -------------------------------- Step 7: Filter status=pending → 2 tasks
    def test_filter_pending(self, temp_dir: str):
        """Filter by status=pending → shows 2 pending tasks, not the done one."""
        _run_with_file("add", "Write report", "1", cwd=temp_dir)
        _run_with_file("add", "Review code", "2", cwd=temp_dir)
        _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)
        _run_with_file("done", "1", cwd=temp_dir)

        result = _run_with_file("filter", "--status", "pending", cwd=temp_dir)

        assert result.returncode == 0
        assert "Review code" in result.stdout
        assert "Deploy to staging" in result.stdout
        assert "Write report" not in result.stdout
        lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
        assert len(lines) == 2

    # ---------------------------------- Step 8: Filter status=done → 1 task
    def test_filter_done(self, temp_dir: str):
        """Filter by status=done → shows the single done task."""
        _run_with_file("add", "Write report", "1", cwd=temp_dir)
        _run_with_file("add", "Review code", "2", cwd=temp_dir)
        _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)
        _run_with_file("done", "1", cwd=temp_dir)

        result = _run_with_file("filter", "--status", "done", cwd=temp_dir)

        assert result.returncode == 0
        assert "Write report" in result.stdout
        assert "Review code" not in result.stdout
        assert "Deploy to staging" not in result.stdout
        lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
        assert len(lines) == 1

    # --------------------------------------- Step 9: Filter priority=2 → 1 task
    def test_filter_priority_exact(self, temp_dir: str):
        """Filter by exact priority 2 → shows 1 task."""
        _run_with_file("add", "Write report", "1", cwd=temp_dir)
        _run_with_file("add", "Review code", "2", cwd=temp_dir)
        _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)

        result = _run_with_file("filter", "--priority", "2", cwd=temp_dir)

        assert result.returncode == 0
        assert "Review code" in result.stdout
        assert "Write report" not in result.stdout
        assert "Deploy to staging" not in result.stdout
        lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
        assert len(lines) == 1

    # --------------------------------------- Step 10: Filter priority 2‑3 → 2 tasks
    def test_filter_priority_range(self, temp_dir: str):
        """Filter by priority range 2‑3 → shows 2 tasks."""
        _run_with_file("add", "Write report", "1", cwd=temp_dir)
        _run_with_file("add", "Review code", "2", cwd=temp_dir)
        _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir)

        result = _run_with_file(
            "filter", "--priority-min", "2", "--priority-max", "3", cwd=temp_dir
        )

        assert result.returncode == 0
        assert "Review code" in result.stdout
        assert "Deploy to staging" in result.stdout
        assert "Write report" not in result.stdout
        lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
        assert len(lines) == 2

    # ------------------------------------------------------ Combined workflow
    def test_full_workflow_end_to_end(self, temp_dir: str):
        """Run the entire 10‑step workflow in sequence in a single session."""
        filename = "tasks.json"

        # 1. Add priority 1
        r = _run_with_file("add", "Write report", "1", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "Added task #1" in r.stdout

        # 2. Add priority 2
        r = _run_with_file("add", "Review code", "2", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "Added task #2" in r.stdout

        # 3. Add priority 3
        r = _run_with_file("add", "Deploy to staging", "3", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "Added task #3" in r.stdout

        # 4. List → 3 tasks
        r = _run_with_file("list", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        lines = [l for l in r.stdout.strip().split("\n") if l.strip()]
        assert len(lines) == 3

        # 5. Mark id=1 done
        r = _run_with_file("done", "1", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "Task #1 marked as done." in r.stdout

        # 6. List → task 1 shows done, others pending
        r = _run_with_file("list", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "[✓]" in r.stdout or "[\u2713]" in r.stdout
        # Done indicator should be on task 1 (Write report)
        assert "Write report" in r.stdout

        # 7. Filter pending → 2 tasks
        r = _run_with_file("filter", "--status", "pending", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "Review code" in r.stdout
        assert "Deploy to staging" in r.stdout
        assert "Write report" not in r.stdout

        # 8. Filter done → 1 task
        r = _run_with_file("filter", "--status", "done", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "Write report" in r.stdout
        assert "Review code" not in r.stdout

        # 9. Filter priority=2 → 1 task
        r = _run_with_file("filter", "--priority", "2", cwd=temp_dir, filename=filename)
        assert r.returncode == 0
        assert "Review code" in r.stdout
        assert "Deploy to staging" not in r.stdout
        assert "Write report" not in r.stdout

        # 10. Filter priority range 2‑3 → 2 tasks
        r = _run_with_file(
            "filter", "--priority-min", "2", "--priority-max", "3",
            cwd=temp_dir, filename=filename,
        )
        assert r.returncode == 0
        assert "Review code" in r.stdout
        assert "Deploy to staging" in r.stdout
        assert "Write report" not in r.stdout