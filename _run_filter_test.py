#!/usr/bin/env python3
"""Run test_todo_filter tests."""
import subprocess
import sys

result = subprocess.run(
    [sys.executable, "-m", "unittest", "test_todo_filter", "-v"],
    capture_output=True, text=True, timeout=30
)
print(result.stdout)
print(result.stderr)
print("RETURNCODE:", result.returncode)
sys.exit(result.returncode)