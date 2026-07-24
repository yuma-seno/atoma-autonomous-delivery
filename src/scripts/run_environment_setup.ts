#!/usr/bin/env bun
/**
 * run_environment_setup.ts — Run each command in config.json's
 * `environment.setup_commands` (if any) via `bash -c`, before the agent
 * starts, so it never has to spend iterations/tool calls doing one-off
 * environment prep itself on a cold runner. No-ops quietly if unset/empty.
 *
 * Mirrors GitHub Actions' own default `bash -e {0}` semantics: the first
 * failing command aborts immediately with its exit code.
 */
import { loadConfig } from "../lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

function main(): void {
  const commands = loadConfig().environment?.setup_commands ?? [];
  if (commands.length === 0) {
    console.log("No environment.setup_commands configured; skipping.");
    return;
  }
  for (const cmd of commands) {
    console.log(`Running environment setup command: ${cmd}`);
    const result = Bun.spawnSync({ cmd: ["bash", "-c", cmd], stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) {
      console.error(`environment setup command failed (exit ${result.exitCode}): ${cmd}`);
      process.exit(result.exitCode ?? 1);
    }
  }
}

if (import.meta.main) main();
