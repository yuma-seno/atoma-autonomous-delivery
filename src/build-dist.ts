#!/usr/bin/env bun
/**
 * build-dist.ts — Copies the one-shot WORKFLOW scripts (and their shared
 * `lib/`) from `src/scripts/` into the deliverable at `dist/.github/scripts/`.
 *
 * `src/scripts/` is now exclusively the source for scripts invoked directly
 * from a `*.wac.ts` file's `run:` step (via `scriptCommand()`/
 * `scriptCommandWithArgs()`) -- this repo's own workflow-automation glue,
 * NOT Atoma's own tooling. Atoma's tool/hook implementations (`mcp/`,
 * `hooks/`, and the handful of scripts they shell out to) live entirely
 * under `dist/.github/atoma/tools/scripts/`, hand-authored directly there
 * with NO `src/` equivalent (this script never touches that directory) --
 * see README.md's Development section for the full rationale and the list
 * of scripts that are deliberately DUPLICATED across both trees (used by
 * both a workflow and Atoma's own tool-calling machinery, each needing a
 * same-directory sibling copy).
 *
 * This is a plain file copy, not a compile step -- Bun runs `.ts` files
 * directly, so "building" here just means "place the source where the
 * deployed workflow expects to find it".
 *
 * `.test.ts` files are intentionally excluded from the copy -- tests are a
 * dev-time concern for this repo, not something end users need in their own
 * `.github/`.
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_SCRIPTS_DIR = join(REPO_ROOT, "src", "scripts");
const DIST_SCRIPTS_DIR = join(REPO_ROOT, "dist", ".github", "scripts");

function main(): void {
  mkdirSync(DIST_SCRIPTS_DIR, { recursive: true });

  // Copy the shared lib/ wholesale.
  const distLibDir = join(DIST_SCRIPTS_DIR, "lib");
  rmSync(distLibDir, { recursive: true, force: true });
  cpSync(join(SRC_SCRIPTS_DIR, "lib"), distLibDir, { recursive: true });

  // Copy every flat *.ts script, excluding tests.
  for (const entry of readdirSync(SRC_SCRIPTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    cpSync(join(SRC_SCRIPTS_DIR, entry.name), join(DIST_SCRIPTS_DIR, entry.name));
  }

  console.log(`build-dist: copied src/scripts/** -> ${DIST_SCRIPTS_DIR}`);
}

main();
