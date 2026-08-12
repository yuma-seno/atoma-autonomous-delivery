#!/usr/bin/env bun
// @bun

// src/scripts/post_result_comment.ts
import { appendFileSync, existsSync, readFileSync } from "fs";
import { parseArgs } from "util";

// src/lib/gh.ts
function run(cmd) {
  const proc = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "",
    stderr: proc.stderr ? proc.stderr.toString("utf8").trim() : ""
  };
}
function gh(...args) {
  return run(["gh", ...args]);
}

// src/lib/agent-name.ts
var AGENT_NAME_PATTERN = "[a-z][a-z0-9-]*";
var AGENT_NAME_RE = new RegExp(`^${AGENT_NAME_PATTERN}$`);

// src/lib/tags.ts
function makeTag(key, valuePattern, parse, render) {
  const re = new RegExp(`<!--\\s*atoma:${key}=(${valuePattern})\\s*-->`);
  return {
    write: (value) => `<!-- atoma:${key}=${render(value)} -->`,
    read: (text) => {
      const m = re.exec(text);
      return m ? parse(m[1]) : undefined;
    },
    has: (text) => re.test(text)
  };
}
function numericTag(key) {
  return makeTag(key, "\\d+", Number, String);
}
function stringTag(key, valuePattern) {
  return makeTag(key, valuePattern, (raw) => raw, (value) => value);
}
var PARENT_TAG = numericTag("parent");
var PARENT_ISSUE_TAG = numericTag("parent-issue");
var NOTIFY_TAG = stringTag("notify", "[A-Za-z0-9-]+");
var ORIGIN_AGENT_TAG = stringTag("origin-agent", AGENT_NAME_PATTERN);
var DISPATCH_TAG = stringTag("dispatch", AGENT_NAME_PATTERN);
var AGENT_TAG = stringTag("agent", AGENT_NAME_PATTERN);
var LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
var AGGREGATED_TAG = numericTag("aggregated");
var SUB_RESULT_TAG = numericTag("sub-result");

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/post_result_comment.ts
var ref = defineScript(import.meta.url);
function tokenUsageLines() {
  if (!existsSync("atoma_logs.txt"))
    return [];
  const usageLine = readFileSync("atoma_logs.txt", "utf8").split(`
`).find((l) => l.includes("ATOMA_TOKEN_USAGE:"));
  if (!usageLine)
    return [];
  const prompt = /prompt=(\d+)/.exec(usageLine)?.[1];
  const completion = /completion=(\d+)/.exec(usageLine)?.[1];
  const total = /total=(\d+)/.exec(usageLine)?.[1];
  const lines = ["", "---", `_Tokens: ${total ?? "?"} total (${prompt ?? "?"} prompt + ${completion ?? "?"} completion)_`];
  if (prompt && completion) {
    const cost = Number(prompt) * 0.15 / 1e6 + Number(completion) * 0.6 / 1e6;
    lines.push(`_Estimated cost: $${cost.toFixed(4)}_`);
  }
  return lines;
}
function buildCommentBody(args) {
  const lines = [AGENT_TAG.write(args.agent), args.output, "", ...args.usageLines];
  if (!args.directive && args.chainContinues !== "true" && args.notify) {
    lines.push(`@${args.notify} \u2014 **${args.agent}** task completed. No agent will be automatically executed next. Please review the results or provide instructions for the next step.`, "");
  }
  lines.push("---", `_run by [${args.agent}](${args.runUrl})_`);
  if (args.maxIterationsReached === "true") {
    lines.push(`\u26A0\uFE0F _Max iterations reached. Comment \`/${args.agent}\` to continue._`);
  }
  return lines.join(`
`);
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" },
      directive: { type: "string" },
      "chain-continues": { type: "string" },
      "max-iterations-reached": { type: "string" },
      "run-url": { type: "string" }
    }
  });
  if (!values.number || !values.agent || !values["run-url"]) {
    console.error("usage: post_result_comment.ts --number N --agent NAME --run-url URL [...]");
    process.exit(2);
  }
  const output = existsSync("atoma_output.txt") ? readFileSync("atoma_output.txt", "utf8") : "";
  if (!output.trim()) {
    console.error("atoma_output.txt is empty (session ended via a tool call) -- skipping result comment.");
    return;
  }
  const body = buildCommentBody({
    agent: values.agent,
    notify: values.notify,
    directive: values.directive,
    chainContinues: values["chain-continues"],
    maxIterationsReached: values["max-iterations-reached"],
    runUrl: values["run-url"],
    output,
    usageLines: tokenUsageLines()
  });
  const { code, stdout, stderr } = gh("api", `repos/${process.env.GITHUB_REPOSITORY}/issues/${values.number}/comments`, "--method", "POST", "-f", `body=${body}`, "--jq", ".id");
  if (code !== 0) {
    throw new Error(`Failed to post result comment: ${stderr || stdout}`);
  }
  const commentId = stdout.trim();
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput)
    appendFileSync(githubOutput, `comment_id=${commentId}
`);
  console.error(`Posted comment ID: ${commentId}`);
}
if (import.meta.main)
  main();
export {
  ref,
  buildCommentBody
};
