#!/usr/bin/env bun
/**
 * post_result_comment.ts — Post the agent's final output as a GitHub
 * comment, including token usage/cost and (when nothing further will
 * happen automatically) a mention.
 *
 * Reads atoma_output.txt (required) and atoma_logs.txt (optional, for the
 * ATOMA_TOKEN_USAGE: line) from the current directory.
 *
 * Usage:
 *   post_result_comment.ts --number N --agent NAME [--notify LOGIN]
 *     [--directive NAME] [--chain-continues true|false]
 *     [--max-iterations-reached true|false] --run-url URL
 * Writes `comment_id=<id>` to $GITHUB_OUTPUT.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh } from "./lib/gh.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface PostResultCommentArgs {
  number: string | number;
  agent: string;
  notify?: string;
  directive?: string;
  "chain-continues"?: string;
  "max-iterations-reached"?: string;
  "run-url": string;
}

export const ref = defineScript<PostResultCommentArgs>(import.meta.url);

function tokenUsageLines(): string[] {
  if (!existsSync("atoma_logs.txt")) return [];
  const usageLine = readFileSync("atoma_logs.txt", "utf8")
    .split("\n")
    .find((l) => l.includes("ATOMA_TOKEN_USAGE:"));
  if (!usageLine) return [];

  const prompt = /prompt=(\d+)/.exec(usageLine)?.[1];
  const completion = /completion=(\d+)/.exec(usageLine)?.[1];
  const total = /total=(\d+)/.exec(usageLine)?.[1];

  const lines = ["", "---", `_Tokens: ${total ?? "?"} total (${prompt ?? "?"} prompt + ${completion ?? "?"} completion)_`];
  if (prompt && completion) {
    const cost = (Number(prompt) * 0.15) / 1_000_000 + (Number(completion) * 0.6) / 1_000_000;
    lines.push(`_Estimated cost: $${cost.toFixed(4)}_`);
  }
  return lines;
}

export function buildCommentBody(args: {
  agent: string;
  notify?: string;
  directive?: string;
  chainContinues?: string;
  maxIterationsReached?: string;
  runUrl: string;
  output: string;
  usageLines: string[];
}): string {
  const lines = [`<!-- atoma:agent=${args.agent} -->`, args.output, "", ...args.usageLines];

  if (!args.directive && args.chainContinues !== "true" && args.notify) {
    lines.push(
      `@${args.notify} — **${args.agent}** task completed. No agent will be automatically executed next. Please review the results or provide instructions for the next step.`,
      "",
    );
  }

  lines.push("---", `_run by [${args.agent}](${args.runUrl})_`);
  if (args.maxIterationsReached === "true") {
    lines.push(`⚠️ _Max iterations reached. Comment \`/${args.agent}\` to continue._`);
  }

  return lines.join("\n");
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" },
      directive: { type: "string" },
      "chain-continues": { type: "string" },
      "max-iterations-reached": { type: "string" },
      "run-url": { type: "string" },
    },
  });

  if (!values.number || !values.agent || !values["run-url"]) {
    console.error("usage: post_result_comment.ts --number N --agent NAME --run-url URL [...]");
    process.exit(2);
  }

  const output = existsSync("atoma_output.txt") ? readFileSync("atoma_output.txt", "utf8") : "";
  const body = buildCommentBody({
    agent: values.agent,
    notify: values.notify,
    directive: values.directive,
    chainContinues: values["chain-continues"],
    maxIterationsReached: values["max-iterations-reached"],
    runUrl: values["run-url"],
    output,
    usageLines: tokenUsageLines(),
  });

  const { code, stdout, stderr } = gh(
    "api",
    `repos/${process.env.GITHUB_REPOSITORY}/issues/${values.number}/comments`,
    "--method",
    "POST",
    "-f",
    `body=${body}`,
    "--jq",
    ".id",
  );
  if (code !== 0) {
    throw new Error(`Failed to post result comment: ${stderr || stdout}`);
  }

  const commentId = stdout.trim();
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `comment_id=${commentId}\n`);
  console.error(`Posted comment ID: ${commentId}`);
}

if (import.meta.main) main();
