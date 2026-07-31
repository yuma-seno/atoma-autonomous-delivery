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

These are not optional reads. Each covers a failure that a diff-only review
cannot see, because the evidence lives in a file the diff does not contain.

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

### `tools.yaml` or an agent definition changed

Read **all** of `.github/atoma/agent-definitions/*.md`, not just the one in the
diff. Every name under an agent's `mcp_servers` must exist as a top-level key in
`tools.yaml`, and the union across all agents must be covered. Adding a server
is safe; removing or renaming one is not.

If `tools.yaml` spawns a command that is not `bun`, that binary has to be
installed by the runner. Confirm the package appears in `mcp-packages.json`.

### Generated output touched

Some files are produced by a build rather than written by hand.

- An edit made directly to one is a defect even when its content is correct. The
  next build overwrites it, so the change it was meant to make is silently lost.
  Require the change in the source the generator reads.
- When the project regenerates and commits that output itself, a diff carrying it
  is also a defect: concurrent branches collide in files no human wrote, and a
  regenerated bundle buries the real change under a far larger diff.
- Establish which convention the project follows before ruling, rather than
  assuming. The build configuration states it.

### The pull request came from a fork

`github__get_pr` reports `isCrossRepository`. When it is true, the working tree is
the **base** branch, not the pull request: running a contributor's code with the
repository's credentials would be an arbitrary-code-execution hole, so the runner
deliberately does not check it out.

Review from the diff, which `github__get_pr_diff` returns through the API. Do not
read a changed file from disk and conclude anything about the change — you would be
reading the pre-change version. Reading *unchanged* files for context is still
fine and still useful.

Do not hand a fork pull request back to the engineer either: it cannot push to
someone else's fork. Report the findings for a human to relay.

### Workflow or runner changed

Trace the values a new step depends on. A step that reads a file must have that
file guaranteed present in the deployed tree, not merely present in the branch
where it was authored.
