#!/usr/bin/env bun
/**
 * manage_dispatch_loop.ts — decide whether the agent chain has gone on long
 * enough to stop and ask a person.
 *
 * The I/O half. Every decision is in `domain/dispatch-chain.ts`, which explains
 * why this counts comments instead of keeping a counter -- briefly: the counter it
 * used to keep could not reach 1, because the reset fired on any new event and
 * every run posts a result comment.
 *
 * Usage:
 *   manage_dispatch_loop.ts --number 123 [--repo owner/name]
 *
 * Writes `auto_dispatch_count=N` and `loop_limit_reached=true|false` to
 * $GITHUB_OUTPUT. The output names are unchanged so the workflow's guards and
 * `decide_guard_release`'s input keep working -- what changed is that they now
 * carry a number that can be greater than zero.
 *
 * No longer takes `--session`. Nothing is written back: the tally is derived, so
 * there is nothing to persist and nothing for a stale session to contradict. Old
 * sessions still carry `metadata.github_context.auto_dispatch_count`; it is dead
 * and nothing reads it.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { handoffLimitReached, handoffsSincePerson, resolveHandoffLimit, type ChainComment } from "../domain/dispatch-chain.ts";
import { getHandoffLimit } from "../lib/config.ts";
import { gh } from "../lib/gh.ts";
import { AGENT_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ManageDispatchLoopArgs {
  number: string | number;
  repo?: string;
}

export const ref = defineScript<ManageDispatchLoopArgs>(import.meta.url);

/**
 * The target's comments, oldest first, reduced to what the decision reads.
 *
 * `--paginate` because a long-running issue passes 100 comments, and the tally is
 * read from the END of the list: a truncated read would silently drop the recent
 * handoffs, which are the only ones that matter.
 *
 * A failed read returns an empty list, which counts zero handoffs and lets the
 * chain continue. That is the wrong direction for a safety limit, and it is
 * deliberate: this bounds a loop that wastes model runs, and refusing to hand off
 * because GitHub was briefly unreachable would stop work that is going fine. The
 * caller logs it so a run that could not check says so.
 */
function readComments(repo: string, number: string): { comments: ChainComment[]; read: boolean } {
  const { code, stdout } = gh(
    "api",
    `repos/${repo}/issues/${number}/comments?per_page=100`,
    "--paginate",
    "--jq",
    // One JSON object per line, the same shape `readChangedFiles` uses and for the
    // same reason: with `--paginate` the pages arrive as separate documents that
    // `JSON.parse` cannot read as one.
    '.[] | {authorType: .user.type, body: .body}',
  );
  if (code) return { comments: [], read: false };
  const comments: ChainComment[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      comments.push(JSON.parse(line) as ChainComment);
    } catch {
      // One unparseable line is not a reason to lose the rest. It also cannot be
      // an agent comment as far as this is concerned, so the tally errs low --
      // the same direction as a failed read.
      console.error(`  Skipping an unparseable comment line`);
    }
  }
  return { comments, read: true };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      repo: { type: "string" },
    },
  });

  const number = values.number ?? "";
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!number || !repo) {
    console.error("usage: manage_dispatch_loop.ts --number N [--repo owner/name]");
    process.exit(2);
  }

  const limit = resolveHandoffLimit(getHandoffLimit());
  const { comments, read } = readComments(repo, number);
  if (!read) console.error(`WARN could not read comments on ${repo}#${number}; treating the chain as fresh`);

  const handoffs = handoffsSincePerson(comments, (body) => AGENT_TAG.has(body));
  const reached = handoffLimitReached(handoffs, limit);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    // The limit travels with the count. The escalation comment names both, and
    // splicing a literal into that comment at synth time is how the old version
    // could have quoted a number that was not the limit in force.
    appendFileSync(
      githubOutput,
      `auto_dispatch_count=${handoffs}\nloop_limit_reached=${reached}\nhandoff_limit=${limit}\n`,
    );
  }
  console.error(`Agent handoffs since a person last commented: ${handoffs}/${limit} (limit_reached=${reached})`);
}

if (import.meta.main) main();
