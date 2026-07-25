---
name: engineering/debugging
description: Diagnose failures by forming one falsifiable local hypothesis and running the cheapest discriminating check.
---

# Focused Debugging

1. Start from the failing behavior, command, test, or nearest concrete call site.
2. Trace to the code that directly computes or mutates the behavior.
3. State one falsifiable hypothesis and one cheap check that could disprove it.
4. Run the check before widening the search.
5. If confirmed, repair the smallest owning slice and rerun the same check.
6. If disproved, move one boundary closer to the controlling code and form a new hypothesis.
7. Finish with a broader regression check appropriate to the affected contract.

Do not hide errors with fallbacks unless degraded behavior is an explicit product requirement. Preserve diagnostic context at process, protocol, and API boundaries.
