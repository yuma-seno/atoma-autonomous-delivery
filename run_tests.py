#!/usr/bin/env python3
"""Quick test runner for test_unit_convert.py"""
import subprocess
import sys

result = subprocess.run(
    [sys.executable, "-m", "pytest", "test_unit_convert.py", "-v"],
    capture_output=True, text=True, timeout=60
)
print(result.stdout)
print(result.stderr)
print("RETURNCODE:", result.returncode)