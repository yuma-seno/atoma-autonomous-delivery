#!/usr/bin/env python3
import subprocess, sys
result = subprocess.run(
    [sys.executable, "-m", "pytest", "test_memo_storage.py", "-v", "--tb=short"],
    capture_output=True, text=True, timeout=60
)
sys.stdout.write("STDOUT:\n" + result.stdout)
sys.stderr.write("STDERR:\n" + result.stderr)
sys.stdout.write("\nEXITCODE: " + str(result.returncode) + "\n")
sys.exit(result.returncode)