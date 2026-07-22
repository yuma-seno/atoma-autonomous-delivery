#!/usr/bin/env bun
/**
 * build-dist.ts — Copies the one-shot workflow-step scripts (and their
 * shared `lib/`) from `src/scripts/` into the deliverable at
 * `dist/.github/atoma/tools/scripts/`.
 *
 * This is a plain file copy, not a compile step -- Bun runs `.ts` files
 * directly, so "building" here just means "place the source where the
 * deployed workflow expects to find it". `dist/.github/atoma/tools/scripts/`
 * also contains hand-authored, NOT-copied content that this script must
 * never touch: `mcp/`, `hooks/`, and `package.json` (see the repo's
 * folder-structure notes in README.md's Development section).
 *
 * `.test.ts` files are intentionally excluded from the copy -- tests are a
 * dev-time concern for this repo, not something end users need in their own
 * `.github/`.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_SCRIPTS_DIR = join(REPO_ROOT, "src", "scripts");
const DIST_SCRIPTS_DIR = join(REPO_ROOT, "dist", ".github", "atoma", "tools", "scripts");

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

  if (!existsSync(join(DIST_SCRIPTS_DIR, "mcp")) || !existsSync(join(DIST_SCRIPTS_DIR, "hooks"))) {
    console.error("build-dist: WARNING: dist/.github/atoma/tools/scripts/{mcp,hooks} are missing.");
  }

  console.log(`build-dist: copied src/scripts/** -> ${DIST_SCRIPTS_DIR}`);
}

main();
