/**
 * workspace-size.ts — when the scratch workspace has grown past what will be kept.
 *
 * ## Why this is checked during the run and not when the workspace is saved
 *
 * Saving happens after the agent has finished. A limit enforced there is correct and
 * useless: the run that wrote the 900 MB file is over, its `/tmp` is gone with the job,
 * and the next run restores the last version that *did* fit — so the agent that is told
 * has nothing to delete and did nothing wrong. The condition has to be reported while
 * the files still exist and the agent can still remove them.
 *
 * So this runs from an `after_tool` hook on every tool, and what it produces is a notice
 * appended to whatever result the agent was already reading. Every tool, because an
 * agent may write a large file through one server and then spend twenty calls in
 * another; a hook on the writing server alone would say nothing for those twenty.
 *
 * ## What the numbers are, and what they are not
 *
 * Measured over every issue this repository has run: the whole `workspace/` tree on
 * `atoma-data` is **five files and 142 bytes**. The limits below are not tuned against
 * that distribution, because there is nothing there to tune against — they are set where
 * a legitimate use cannot reach and an accident lands immediately.
 *
 * ```text
 *   total       5 MB    ~37,000x the measured usage; one build artifact exceeds it
 *   one file    1 MB    separates "a big thing" from "many small things", which
 *                       have different causes and different fixes
 *   files        200    a copied node_modules trips this before it trips the bytes
 * ```
 *
 * The three exist separately because the notice has to say what to do, and "delete the
 * 900 MB bundle" and "you have copied a dependency tree in here" are different
 * sentences.
 */

/** Everything the limits are compared against, and everything the notice quotes. */
export interface WorkspaceUsage {
  bytes: number;
  files: number;
  /** The largest files, biggest first, so the notice can name them. */
  largest: { path: string; bytes: number }[];
}

/** Total size of the workspace, above which nothing in it is carried forward. */
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** Size of a single file, above which that file alone is the problem. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** How many files may be there, whatever they weigh. */
export const MAX_FILES = 200;

/** How many of the largest files the notice names. Enough to act on, not a listing. */
const NAMED = 3;

function readable(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * What to tell the agent, or nothing.
 *
 * Phrased as a consequence rather than as a rule: "nothing you put there will reach the
 * next run" is a fact about its work, where "the workspace exceeds its limit" is a fact
 * about our configuration. Measured elsewhere in this repository, a refusal that said
 * what to do instead was followed and one that only said no was not.
 */
export function overLimitNotice(usage: WorkspaceUsage, path: string): string | undefined {
  const reasons: string[] = [];
  if (usage.bytes > MAX_TOTAL_BYTES) {
    reasons.push(`it holds ${readable(usage.bytes)}, over the ${readable(MAX_TOTAL_BYTES)} limit`);
  }
  if (usage.files > MAX_FILES) {
    reasons.push(`it holds ${usage.files} files, over the limit of ${MAX_FILES}`);
  }
  const huge = usage.largest.filter((f) => f.bytes > MAX_FILE_BYTES);
  if (huge.length > 0) {
    const subject = huge.length === 1 ? "one file is" : `${huge.length} files are`;
    reasons.push(`${subject} over the ${readable(MAX_FILE_BYTES)} single-file limit`);
  }
  if (reasons.length === 0) return undefined;

  const named = usage.largest
    .slice(0, NAMED)
    .map((f) => `  ${readable(f.bytes).padStart(9)}  ${f.path}`)
    .join("\n");

  return [
    `--- ${path} is over its limit; this is not part of the answer above ---`,
    `Nothing you have put there will reach the next run on this issue: ${reasons.join(", and ")}.`,
    "",
    "The largest are:",
    named,
    "",
    `Delete what the next run does not need. ${path} is an ordinary directory, so the ` +
      "tools you already use remove a file there. Build output, dependency trees and logs do not " +
      "belong in it; notes, scratch scripts and intermediate results do. If what is there is only " +
      "useful to you now, leave it and let it go when this run ends.",
  ].join("\n");
}
