/**
 * run-atoma.ts — shared helper for tests/e2e/*.e2e.test.ts: spawns the real,
 * pre-built `atoma` binary asynchronously and awaits its exit.
 *
 * ATOMA_BIN env var overrides the default sibling-checkout path
 * (../atoma/target/debug/atoma, relative to this repo's root, matching this
 * exact workspace's layout).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const ATOMA_BIN = process.env.ATOMA_BIN ?? join(REPO_ROOT, "..", "atoma/target/debug/atoma");
export const atomaAvailable = existsSync(ATOMA_BIN);

export interface RunAtomaOpts {
  agentDefPath: string;
  toolsFilePath: string;
  promptFilePath: string;
  outSessionPath: string;
  templatePath?: string;
  skillsDir?: string;
  maxIterations?: number;
  env: Record<string, string>;
}

export interface RunAtomaResult {
  exitCode: number | null;
  stderr: string;
}

/**
 * Spawns the real `atoma` binary with `Bun.spawn` (async), NOT
 * `Bun.spawnSync`: spawnSync blocks this whole JS thread until the child
 * exits, which would starve the event loop a `Bun.serve()` mock LLM server
 * needs in order to answer the atoma binary's HTTP requests -- a deadlock,
 * since atoma would then be waiting forever for an LLM response that never
 * gets handled.
 */
export async function runAtoma(opts: RunAtomaOpts): Promise<RunAtomaResult> {
  const skillsArgs = opts.skillsDir ? ["--skills-dir", opts.skillsDir] : [];
  const templateArgs = opts.templatePath ? ["--template", opts.templatePath] : [];
  const proc = Bun.spawn({
    cmd: [
      ATOMA_BIN,
      "run",
      "--agent-def",
      opts.agentDefPath,
      "--tools-file",
      opts.toolsFilePath,
      "--prompt-file",
      opts.promptFilePath,
      "--out-session",
      opts.outSessionPath,
      ...templateArgs,
      ...skillsArgs,
      "--max-iterations",
      String(opts.maxIterations ?? 5),
    ],
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { exitCode, stderr };
}
