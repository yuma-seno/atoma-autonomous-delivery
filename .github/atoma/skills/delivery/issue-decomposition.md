---
name: delivery/issue-decomposition
description: Split a delivery issue into independently executable sub-issues with explicit dependencies and acceptance criteria.
---

# Issue Decomposition

Use this skill when deciding whether work is ready for implementation or needs another orchestration layer.

1. Establish the user-visible outcome and constraints before splitting work.
2. Divide by ownership boundary or independently verifiable behavior, not by arbitrary file count.
3. Give every sub-issue a concrete scope, relevant context, acceptance criteria, and required validation.
4. Identify true dependencies. A consumer or test that requires another task's final interface must run later.
5. Assign each child to `orchestrator` by default. Assign `engineer` only when the child has one coherent responsibility, observable acceptance criteria, known interfaces, no unresolved material decision, and can be implemented and verified as one PR without further decomposition.
6. Ensure every recursive child is narrower or less ambiguous than its parent; never reproduce the same scope at another level.
7. Launch independent roots together; keep dependent tasks pending until prerequisites land.
8. Avoid plan-only, coordination-only, or duplicate documentation issues. The executable sub-issues are the plan.
9. On re-entry, verify current GitHub state before launching or aggregating; do not rely on remembered phase state.

If the current issue already satisfies every engineer-leaf condition, hand it directly to `engineer` instead of creating a redundant child issue.
