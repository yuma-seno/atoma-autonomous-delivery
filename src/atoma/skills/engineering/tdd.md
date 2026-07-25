---
name: engineering/tdd
description: Implement behavioral changes with a focused red-green-refactor loop and evidence from executable tests.
---

# Test-Driven Development

Use this skill for feature work, bug fixes, and behavior-preserving refactors where an executable test is practical.

1. Identify the narrowest externally observable behavior and its controlling code path.
2. Add or select one focused test that fails for the expected reason.
3. Implement the smallest coherent change that makes the test pass.
4. Run that focused test immediately.
5. Refactor only after it passes, preserving the same test as a guard.
6. Run the broader checks appropriate to the change's blast radius.

Do not create tests that merely duplicate implementation details. Prefer public behavior, stable contracts, and regression cases that would have caught the original defect.
