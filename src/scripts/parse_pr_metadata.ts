#!/usr/bin/env bun
/**
 * parse_pr_metadata.ts — Parse the `<!-- atoma:parent-issue=N -->` tag and
 * the `Closes #N` sub-issue reference from a merged PR's body.
 *
 * Env: PR_BODY, PR_NUMBER
 * Writes `parent_number=<N-or-empty>` and `sub_number=<N-or-empty>` to
 * $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";
import { PARENT_ISSUE_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

function main(): void {
  const body = process.env.PR_BODY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;

  // Kept as a string: it is written straight to $GITHUB_OUTPUT, and an absent
  // tag has to render as empty so the caller's `if: ... != ''` stays false.
  const parentIssue = PARENT_ISSUE_TAG.read(body);
  const parent = parentIssue === undefined ? "" : String(parentIssue);
  if (parent) console.error(`PR #${prNumber} is linked to parent issue #${parent}`);
  else console.error(`PR #${prNumber} has no parent-issue metadata`);

  const sub = /Closes #(\d+)/.exec(body)?.[1] ?? "";
  if (sub) console.error(`PR closes sub-issue #${sub}`);

  if (githubOutput) {
    appendFileSync(githubOutput, `parent_number=${parent}\nsub_number=${sub}\n`);
  }
}

if (import.meta.main) main();
