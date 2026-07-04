#!/usr/bin/env python3
"""Match a GitHub event to an agent from config.json auto_triggers."""
import json, os, sys

event = os.environ.get("EVENT_TYPE", "")
review_state = os.environ.get("REVIEW_STATE", "")
is_draft = os.environ.get("IS_DRAFT", "")

with open(".github/atoma/config.json") as f:
    config = json.load(f)

for trigger in config.get("auto_triggers", []):
    if trigger["event"] != event:
        continue
    condition = trigger.get("condition")
    if condition == "changes_requested" and review_state != "changes_requested":
        continue
    if condition == "non_draft" and is_draft == "true":
        continue
    agent = trigger["agent"]
    if agent.startswith("$"):
        continue
    print(agent)
    sys.exit(0)
