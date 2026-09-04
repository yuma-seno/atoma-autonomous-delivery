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
var CHANGED_TAG = stringTag("changed", "yes|no");
var LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
var AGGREGATED_TAG = numericTag("aggregated");
var SUB_RESULT_TAG = numericTag("sub-result");
var CI_RETRY_TAG = numericTag("ci-retry");

// src/domain/completion-mention.ts
function shouldMentionOnCompletion(signals) {
  if (!signals.notify)
    return false;
  if (signals.directive)
    return false;
  if (signals.chainContinues)
    return false;
  if (signals.isSubIssue && signals.issueClosed)
    return false;
  return true;
}

// src/domain/redaction.ts
var PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
];
var REDACTED = "[redacted]";
function redact(text, literals = []) {
  let out = text;
  for (const literal of literals)
    out = out.split(literal).join(REDACTED);
  for (const pattern of PATTERNS)
    out = out.replace(pattern, REDACTED);
  return out;
}

// src/domain/mention.ts
var MENTION = /(^|[^\w@/-])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\b(?!\/)/g;
var CODE = /```[\s\S]*?```|`[^`\n]*`/g;
function escapeUnknownMentions(text, known) {
  const allowed = new Set([...known].map((login) => login.trim().toLowerCase()).filter(Boolean));
  const escaped = [];
  const transform = (segment) => segment.replace(MENTION, (whole, before, login) => {
    if (allowed.has(login.toLowerCase()))
      return whole;
    if (!escaped.includes(login))
      escaped.push(login);
    return `${before}\`@${login}\``;
  });
  let out = "";
  let last = 0;
  CODE.lastIndex = 0;
  for (const match of text.matchAll(CODE)) {
    const at = match.index ?? 0;
    out += transform(text.slice(last, at));
    out += match[0];
    last = at + match[0].length;
  }
  out += transform(text.slice(last));
  return { text: out, escaped };
}
function escapedMentionNotice(escaped) {
  if (escaped.length === 0)
    return;
  const names = escaped.map((login) => `\`@${login}\``).join(", ");
  return `> [!NOTE]
` + `> ${names} ${escaped.length === 1 ? "was" : "were"} written as ${escaped.length === 1 ? "a mention" : "mentions"} ` + `and had the notification removed: this run could not confirm ${escaped.length === 1 ? "that account" : "those accounts"} ` + `as a participant in this repository or this thread. Nobody was notified. If the mention was meant, mention them yourself.`;
}

// src/lib/participants.ts
function knownParticipants(repo, number) {
  if (!repo || !String(number).trim())
    return [];
  const logins = new Set;
  const collect = (args, read) => {
    const { code, stdout } = gh(...args);
    if (code !== 0)
      return;
    try {
      for (const login of read(JSON.parse(stdout))) {
        if (typeof login === "string" && login)
          logins.add(login);
      }
    } catch {}
  };
  collect(["api", `repos/${repo}/issues/${number}`], (json) => [
    json.user?.login
  ]);
  collect(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"], (json) => json.map((comment) => comment.user?.login));
  collect(["api", `repos/${repo}/collaborators`, "--paginate"], (json) => json.map((person) => person.login));
  return [...logins];
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/post_result_comment.ts
var ref = defineScript(import.meta.url);
function tokenUsageLines(logsFile) {
  if (!existsSync(logsFile))
    return [];
  const usageLine = readFileSync(logsFile, "utf8").split(`
`).find((l) => l.includes("ATOMA_TOKEN_USAGE:"));
  if (!usageLine)
    return [];
  const prompt = /prompt=(\d+)/.exec(usageLine)?.[1];
  const completion = /completion=(\d+)/.exec(usageLine)?.[1];
  const total = /total=(\d+)/.exec(usageLine)?.[1];
  return ["", "---", `_Tokens: ${total ?? "?"} total (${prompt ?? "?"} prompt + ${completion ?? "?"} completion)_`];
}
function subIssueState(number, type) {
  if (type !== "issue")
    return { isSubIssue: false, issueClosed: false };
  const { code, stdout } = gh("issue", "view", number, "--repo", process.env.GITHUB_REPOSITORY ?? "", "--json", "state,body");
  if (code !== 0)
    return { isSubIssue: false, issueClosed: false };
  try {
    const issue = JSON.parse(stdout);
    return {
      isSubIssue: PARENT_TAG.read(issue.body ?? "") !== undefined,
      issueClosed: issue.state === "CLOSED"
    };
  } catch {
    return { isSubIssue: false, issueClosed: false };
  }
}
function lastAgentText(sessionPath) {
  if (!sessionPath || !existsSync(sessionPath))
    return;
  let session;
  try {
    session = JSON.parse(readFileSync(sessionPath, "utf8"));
  } catch {
    return;
  }
  const messages = session.messages ?? [];
  for (let i = messages.length - 1;i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant")
      continue;
    const content = message.content;
    if (typeof content === "string" && content.trim() !== "")
      return content;
  }
  return;
}
function buildCommentBody(args) {
  const lines = [
    AGENT_TAG.write(args.agent),
    CHANGED_TAG.write(args.changed === true ? "yes" : "no")
  ];
  if (args.salvaged === true) {
    lines.push("> [!WARNING]", "> This run hit its iteration limit and never wrote a report. Below is the last thing it said,", "> from the middle of the work \u2014 not a conclusion, and not a summary of what it found.", "");
  }
  lines.push(args.output, "", ...args.usageLines);
  const escapedNotice = escapedMentionNotice(args.escapedMentions ?? []);
  if (escapedNotice !== undefined)
    lines.push("", escapedNotice, "");
  if (shouldMentionOnCompletion({
    directive: args.directive,
    chainContinues: args.chainContinues === "true",
    notify: args.notify,
    isSubIssue: args.isSubIssue ?? false,
    issueClosed: args.issueClosed ?? false
  })) {
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
      type: { type: "string" },
      notify: { type: "string" },
      directive: { type: "string" },
      "chain-continues": { type: "string" },
      "max-iterations-reached": { type: "string" },
      "run-url": { type: "string" },
      changed: { type: "string" },
      session: { type: "string" },
      output: { type: "string" },
      "logs-file": { type: "string" }
    }
  });
  if (!values.number || !values.agent || !values["run-url"]) {
    console.error("usage: post_result_comment.ts --number N --agent NAME --run-url URL [...]");
    process.exit(2);
  }
  const outputFile = values.output;
  if (!outputFile) {
    console.error("post_result_comment.ts: --output is required (the agent's stdout file)");
    process.exit(2);
  }
  const redacted = redact(existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "");
  let output = redacted;
  let salvaged = false;
  if (!output.trim() && values["max-iterations-reached"] === "true") {
    const last = lastAgentText(values.session);
    if (last !== undefined) {
      output = redact(last);
      salvaged = true;
      console.error("salvaged the agent's last message from the session (iteration limit)");
    }
  }
  if (!output.trim()) {
    console.error("atoma_output.txt is empty (session ended via a tool call) -- skipping result comment.");
    return;
  }
  const checked = escapeUnknownMentions(output, knownParticipants(process.env.GITHUB_REPOSITORY ?? "", values.number));
  if (checked.escaped.length > 0) {
    console.error(`escaped ${checked.escaped.length} unconfirmed mention(s): ${checked.escaped.join(", ")}`);
  }
  const body = buildCommentBody({
    agent: values.agent,
    salvaged,
    notify: values.notify,
    directive: values.directive,
    chainContinues: values["chain-continues"],
    maxIterationsReached: values["max-iterations-reached"],
    runUrl: values["run-url"],
    output: checked.text,
    escapedMentions: checked.escaped,
    changed: values.changed === "true",
    usageLines: tokenUsageLines(values["logs-file"] ?? ""),
    ...subIssueState(values.number, values.type)
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
  buildCommentBody,
  lastAgentText,
  ref
};
