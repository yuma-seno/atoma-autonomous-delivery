/**
 * branch-rules.ts — what a branch's protection requires, and whether that answer
 * could be determined at all.
 *
 * One reader, because there are two callers and they are the two halves of one
 * contract. `validate_pull_request.ts` writes a Checks API check run for each
 * context this returns; `merge-readiness.ts` then blocks the merge for each
 * context this returns that has no passing run. If the two lists ever differ,
 * the mirror writes the wrong set and the pull request is blocked on a check
 * nothing will ever create — silently, since a duplicated reader would degrade
 * to an empty list on both sides.
 *
 * ## Why the result says whether it is known
 *
 * The previous readers returned `string[]` and used `[]` for four different
 * situations: the branch has no rule, the API call failed, the response did not
 * parse, and no base ref was given. Only the first of those means "nothing is
 * required". The rest mean "this could not be determined", and collapsing them
 * cost a real guarantee: `passed = checks.every(...)` is `true` for an empty
 * list, so a failed read reported a **failing** run as passed, which suppressed
 * the failure comment, which is also the retry tally, so the retry limit that
 * bounds the engineer/CI loop could never fire.
 *
 * Returning the distinction makes each caller answer for itself what an unknown
 * means, which is the only place that question can be answered honestly.
 */
import { gh } from "./gh.ts";

interface BranchRule {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] };
}

export type RequiredChecks =
  /** The branch's protection was read. `contexts` may legitimately be empty. */
  | { known: true; contexts: string[] }
  /** The branch's protection could not be read. `why` is for a log or a report. */
  | { known: false; why: string };

/**
 * Status-check contexts the branch's protection requires.
 *
 * Read from the repository rather than hardcoded, so editing
 * `.github/atoma/rulesets/*.json` changes what is enforced with no code change.
 */
export function readRequiredChecks(repo: string, baseRef: string): RequiredChecks {
  if (!baseRef) return { known: false, why: "no base branch was given" };

  const { code, stdout } = gh("api", `repos/${repo}/rules/branches/${baseRef}`);
  if (code) return { known: false, why: `the branch rules for ${baseRef} could not be read` };

  try {
    const rules = JSON.parse(stdout || "[]") as BranchRule[];
    return {
      known: true,
      contexts: rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context),
    };
  } catch {
    return { known: false, why: `the branch rules for ${baseRef} were not valid JSON` };
  }
}
