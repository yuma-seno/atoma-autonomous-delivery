#!/usr/bin/env bun
/**
 * extract_directive.ts — Extract the next-agent directive from the first
 * command-like line of the agent's final text output.
 *
 * Accepts a standalone "/engineer" line and the common
 * markdown-mangled form "/`engineer`". A candidate is only accepted if it
 * names a real agent (a matching .md file exists in --def-dir) -- this
 * guards against false positives like a model writing "/agent reviewer"
 * (matching "agent", not a real agent name) instead of the expected
 * "/reviewer", which would otherwise dispatch a doomed-to-fail run for a
 * non-existent agent definition.
 *
 * Usage: extract_directive.ts --output-file atoma_output.txt --def-dir DIR
 * Writes `directive=<name-or-empty>` to $GITHUB_OUTPUT.
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";

export interface ExtractDirectiveArgs {
  "output-file": string;
  "def-dir": string;
}

export const ref = defineScript<ExtractDirectiveArgs>(import.meta.url);

const COMMAND_RE = /^\/([a-z][a-z0-9-]+)$/;

function candidates(rawLine: string): string[] {
  let line = rawLine.trim();
  if (!line) return [];
  line = line.replace(/^(?:[-*+]\s+|>\s*)+/, "");
  const variants = [line];
  if (line.startsWith("`") && line.endsWith("`") && line.length > 2) {
    variants.push(line.slice(1, -1).trim());
  }
  if (line.startsWith("/`") && line.endsWith("`") && line.length > 3) {
    variants.push("/" + line.slice(2, -1).trim());
  }
  return variants;
}

export function extractDirective(output: string, defDir: string): string {
  for (const rawLine of output.split("\n")) {
    for (const candidate of candidates(rawLine)) {
      const match = COMMAND_RE.exec(candidate);
      if (match) {
        const agent = match[1]!;
        if (existsSync(join(defDir, `${agent}.md`))) return agent;
      }
    }
  }
  return "";
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "output-file": { type: "string" },
      "def-dir": { type: "string" },
    },
  });
  if (!values["output-file"] || !values["def-dir"]) {
    console.error("usage: extract_directive.ts --output-file FILE --def-dir DIR");
    process.exit(2);
  }

  const output = existsSync(values["output-file"]) ? readFileSync(values["output-file"], "utf8") : "";
  const directive = extractDirective(output, values["def-dir"]);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `directive=${directive}\n`);
}

if (import.meta.main) main();
