---
name: review/quick-quality-gate
description: Review a pull request quickly for concrete correctness, security, contract, and regression failures.
---

# Quick Quality Gate

Review for merge-blocking defects, not optional polish.

1. Inspect prior review rounds to understand loop state.
2. Read the PR diff and identify changed behavioral contracts.
3. Check for incorrect control flow, unsafe input or command handling, stale generated output, broken compatibility, and missing regression coverage.
4. Run the mandatory checks below for whichever categories the diff touches.
5. Distinguish evidence-backed defects from stylistic preferences.
6. If sound, submit the required LGTM review and follow the configured merge policy.
7. If defective, return a concise engineer directive naming the behavior, location, and expected correction.
8. Escalate rather than continuing an exhausted review loop.

Do not broaden into unrelated architecture review. A finding must describe a concrete failure mode or requirement violation.

## Mandatory checks

These are not optional reads. Each one has already let a breaking change merge.

### Anything removed

A diff that deletes a named thing — a YAML key, a list entry, a file, an exported
symbol, a config field — is only safe once you have looked for its users
yourself.

- Search the repository for the exact name with `github__search_code`, and read
  any file that plausibly references it with `filesystem_readonly__read_file`.
- "Unused", "dead", or "never exposed" in a PR description is a claim, not
  evidence. Verify it or reject it. An author sees the surface they were working
  on; a consumer in another file is exactly what they cannot see.
- If a search is not possible, the removal is unverified. Say so and return it.

A past merge deleted the `filesystem` server from `tools.yaml` as "unused" while
`engineer.md` still declared it in `mcp_servers`. Atoma aborts the run before
starting any MCP server when that name cannot be resolved, so the next engineer
dispatch failed outright. One read of the three agent definitions would have
caught it.

### `tools.yaml` or an agent definition changed

Read **all** of `.github/atoma/agent-definitions/*.md`, not just the one in the
diff. Every name under an agent's `mcp_servers` must exist as a top-level key in
`tools.yaml`, and the union across all agents must be covered. Adding a server
is safe; removing or renaming one is not.

If `tools.yaml` spawns a command that is not `bun`, that binary has to be
installed by the runner. Confirm the package appears in `mcp-packages.json`.

### Generated output touched

`dist/**` and `.github/atoma/**` are build output, produced from `src/**` by
`bun run synth`. Both are wiped and regenerated; the deploy job literally runs
`rm -rf .github` before repopulating from `dist/`.

- **A pull request must not contain them at all.** Generated output is the deploy
  job's to produce, after the merge. A diff carrying it is a defect regardless of
  whether the content is correct: parallel branches collide in files no human
  wrote, and a regenerated bundle buries the `src/` change under a
  five-figure diff.
- An edit to them *instead of* to `src/**` is the worse version of the same
  defect — it survives until the next deploy and then silently disappears.
- A new static file under `src/atoma/` must also be added to `build-dist.ts`'s
  verbatim-copy list, or it never reaches `dist/` at all.

### Workflow or runner changed

Trace the values a new step depends on. A step that reads a file must have that
file guaranteed present in the deployed tree, not merely present in the branch
where it was authored.
