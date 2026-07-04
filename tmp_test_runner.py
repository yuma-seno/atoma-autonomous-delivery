#!/usr/bin/env python3
"""Run a quick subset of tests for verification."""
import json, os, subprocess, sys

passed = 0
failed = 0

def check(name, ok, msg=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"OK {name}")
    else:
        failed += 1
        print(f"FAIL {name}: {msg}")

# test6: config.json orchestrator max_iterations
with open(".github/atoma/config.json") as f:
    c = json.load(f)
check("config.json orchestrator max_iterations==100",
      c["version"] == 2 and c["agents"]["orchestrator"]["max_iterations"] == 100,
      f"got version={c['version']}, max_iterations={c['agents']['orchestrator']['max_iterations']}")

# test1: syntax check
r = subprocess.run(["python3", "-c", "import py_compile; py_compile.compile('.github/atoma/tools/scripts/match_trigger.py')"], capture_output=True, text=True)
check("match_trigger.py syntax", r.returncode == 0, r.stderr)

# test2: executable
check("launch_sub_agent.sh executable", os.access(".github/atoma/tools/scripts/launch_sub_agent.sh", os.X_OK))

# test14: syntax
r = subprocess.run(["python3", "-c", "import py_compile; py_compile.compile('.github/atoma/tools/scripts/inject_sub_results.py')"], capture_output=True, text=True)
check("inject_sub_results.py syntax", r.returncode == 0, r.stderr)

# test13: shell_guard allows safe
r = subprocess.run(["python3", ".github/atoma/tools/scripts/shell_guard.py"], input=json.dumps({"arguments":{"command":"ls -la"}}), capture_output=True, text=True)
check("shell_guard allows safe", '"allow": true' in r.stdout)

# test12: shell_guard blocks dangerous
r = subprocess.run(["python3", ".github/atoma/tools/scripts/shell_guard.py"], input=json.dumps({"arguments":{"command":"git push origin main"}}), capture_output=True, text=True)
check("shell_guard blocks dangerous", '"allow": false' in r.stdout)

print(f"\nResults: {passed}/{passed+failed} passed, {failed} failed")
sys.exit(1 if failed else 0)