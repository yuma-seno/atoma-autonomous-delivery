---
name: review/quick-quality-gate
description: Review a pull request quickly for concrete correctness, security, contract, and regression failures.
---

# Quick Quality Gate

Review for merge-blocking defects, not optional polish.

1. Inspect prior review rounds to understand loop state.
2. Read the PR diff and identify changed behavioral contracts.
3. Check for incorrect control flow, unsafe input or command handling, stale generated output, broken compatibility, and missing regression coverage.
4. Distinguish evidence-backed defects from stylistic preferences.
5. If sound, submit the required LGTM review and follow the configured merge policy.
6. If defective, return a concise engineer directive naming the behavior, location, and expected correction.
7. Escalate rather than continuing an exhausted review loop.

Do not broaden into unrelated architecture review. A finding must describe a concrete failure mode or requirement violation.
