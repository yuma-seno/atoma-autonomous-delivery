---
name: delivery/issue-decomposition
description: Split a delivery issue into independently executable sub-issues with explicit dependencies and acceptance criteria.
---

# Issue Decomposition

Use this skill when a task spans multiple independently deliverable concerns.

1. Establish the user-visible outcome and constraints before splitting work.
2. Divide by ownership boundary or independently verifiable behavior, not by arbitrary file count.
3. Give every sub-issue a concrete scope, relevant context, acceptance criteria, and required validation.
4. Identify true dependencies. A consumer or test that requires another task's final interface must run later.
5. Launch independent roots together; keep dependent tasks pending until prerequisites land.
6. Avoid plan-only, coordination-only, or duplicate documentation issues. The executable sub-issues are the plan.
7. On re-entry, verify current GitHub state before launching or aggregating; do not rely on remembered phase state.

Prefer a single engineer task when splitting would create coordination overhead without independent ownership or validation.
