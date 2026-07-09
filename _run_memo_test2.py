#!/usr/bin/env python3
import subprocess, sys
with open("/tmp/pytest_out.txt", "w") as f:
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "test_memo_storage.py", "-v", "--tb=short"],
        capture_output=True, text=True, timeout=60
    )
    f.write(result.stdout)
    f.write(result.stderr)
    f.write(f"\nRETURNCODE: {result.returncode}")