#!/usr/bin/env python3
"""Verify that all three agent definition files have valid YAML frontmatter with extra_body."""
import yaml
import sys

files = [
    ".github/atoma/agent-definitions/orchestrator.md",
    ".github/atoma/agent-definitions/engineer.md",
    ".github/atoma/agent-definitions/reviewer.md",
]

all_ok = True
for path in files:
    content = open(path).read()
    parts = content.split("---")
    if len(parts) < 3:
        print(f"FAIL {path}: no valid YAML frontmatter")
        all_ok = False
        continue
    frontmatter = parts[1]
    data = yaml.safe_load(frontmatter)
    print(f"OK {path}: name={data.get('name')}, model={data.get('model')}")
    if "extra_body" not in data:
        print(f"  FAIL: missing extra_body")
        all_ok = False
        continue
    tools = data["extra_body"].get("tools", [])
    tool_types = [t["type"] for t in tools]
    if "openrouter:web_search" not in tool_types:
        print(f"  FAIL: missing openrouter:web_search")
        all_ok = False
    if "openrouter:web_fetch" not in tool_types:
        print(f"  FAIL: missing openrouter:web_fetch")
        all_ok = False
    print(f"  OK: tools={tool_types}")

sys.exit(0 if all_ok else 1)