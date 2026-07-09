#!/usr/bin/env python3
"""Install pytest and run the test suite."""
import subprocess
import sys

install = subprocess.run(
    [sys.executable, "-m", "pip", "install", "pytest"],
    capture_output=True, text=True, timeout=120
)
print("INSTALL STDOUT:", install.stdout)
print("INSTALL STDERR:", install.stderr[:500])
print("INSTALL RETURNCODE:", install.returncode)

if install.returncode != 0:
    sys.exit(1)

result = subprocess.run(
    [sys.executable, "-m", "pytest", "test_unit_convert.py", "-v"],
    capture_output=True, text=True, timeout=60
)
print("TEST STDOUT:", result.stdout)
print("TEST STDERR:", result.stderr)
print("TEST RETURNCODE:", result.returncode)
sys.exit(result.returncode)