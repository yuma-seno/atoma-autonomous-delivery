#!/usr/bin/env bun
/**
 * workspace_guard.ts — tells the agent when its scratch workspace has grown past
 * what will be carried into the next run, while it can still do something about it.
 *
 * Invoked as an `after_tool` hook declared file-wide in `tools.yaml`, so it runs after
 * every call to every server. See `domain/workspace-size.ts` for why it is every server
 * and why the check is here rather than where the workspace is saved.
 *
 * ## What it answers
 *
 * `{"notice": "..."}` on stdout, which Atoma appends to the result the agent is already
 * reading. Anything else — no output, a crash, a timeout — adds nothing and the call it
 * followed is unaffected. That is the contract this side is written to: an after-hook
 * reports on work that has already happened, so this file never fails a tool call, and
 * every error path below ends in silence rather than in an exception.
 *
 * ## Why it walks the tree on every call
 *
 * The measured workspace is five files. Walking it costs microseconds, and the walk
 * stops early once it has seen enough to know the answer, so the pathological case —
 * somebody copied `node_modules` in — is the cheapest one to detect rather than the most
 * expensive. What it must not do is cache: the file that matters is the one written by
 * the call that just finished.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_PATH } from "../../../../domain/workspace.ts";
import { MAX_FILES, overLimitNotice, type WorkspaceUsage } from "../../../../domain/workspace-size.ts";

/**
 * Stop walking once this many files have been seen.
 *
 * Past `MAX_FILES` the answer cannot change: the count alone already trips the limit,
 * and the notice names the largest files it found rather than claiming to have found
 * the largest that exist. Bounded work on a directory whose size is the problem.
 */
const WALK_CEILING = MAX_FILES + 1;

/** How many of the largest files to keep while walking. The notice names three. */
const KEEP_LARGEST = 5;

function measure(root: string): WorkspaceUsage {
  const usage: WorkspaceUsage = { bytes: 0, files: 0, largest: [] };
  const stack = [root];

  while (stack.length > 0 && usage.files < WALK_CEILING) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory that cannot be read is not a reason to say anything: the
      // workspace may simply not exist yet, which is the common case.
      continue;
    }
    for (const entry of entries) {
      if (usage.files >= WALK_CEILING) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      // Symlinks are counted as the link, not as what they point at: following them
      // would let one into a size that is not in the workspace at all, and would
      // loop on a cycle.
      if (!entry.isFile()) continue;
      let size;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      usage.files += 1;
      usage.bytes += size;
      usage.largest.push({ path, bytes: size });
      if (usage.largest.length > KEEP_LARGEST * 4) {
        usage.largest.sort((a, b) => b.bytes - a.bytes);
        usage.largest.length = KEEP_LARGEST;
      }
    }
  }

  usage.largest.sort((a, b) => b.bytes - a.bytes);
  usage.largest.length = Math.min(usage.largest.length, KEEP_LARGEST);
  return usage;
}

async function main(): Promise<void> {
  // The payload is read and discarded. Nothing here depends on which tool ran: the
  // question is about the directory's state, and the answer is the same whoever asked.
  // It is still read, because leaving stdin unread closes the pipe under the writer.
  try {
    await new Response(Bun.stdin.stream()).text();
  } catch {
    // Nothing to do with it either way.
  }

  try {
    const notice = overLimitNotice(measure(WORKSPACE_PATH), WORKSPACE_PATH);
    if (notice !== undefined) {
      console.error(`[workspace_guard] the workspace is over its limit; telling the agent`);
      console.log(JSON.stringify({ notice }));
    }
  } catch (error) {
    // Never the agent's problem. The run log is where this belongs.
    console.error(`[workspace_guard] could not measure ${WORKSPACE_PATH}: ${(error as Error).message}`);
  }
}

if (import.meta.main) await main();
