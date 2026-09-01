#!/usr/bin/env bun
// @bun

// src/scripts/fetch_events.ts
import { appendFileSync, writeFileSync } from "fs";
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
function ghRead(...args) {
  let result = gh(...args);
  for (const delay of [2000, 6000]) {
    if (result.code === 0 || !looksTransient(result))
      return result;
    console.error(`::warning::gh ${args.slice(0, 2).join(" ")} failed transiently, retrying: ${result.stderr || result.stdout}`);
    Bun.sleepSync(delay);
    result = gh(...args);
  }
  return result;
}
function looksTransient(result) {
  const text = `${result.stderr} ${result.stdout}`;
  if (/HTTP (429|5[0-9][0-9])(?![0-9])/.test(text))
    return true;
  return /(timeout|timed out|connection reset|unexpected EOF|TLS handshake|temporary failure)/i.test(text);
}
function ghJson(...args) {
  const { code, stdout, stderr } = gh(...args);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")}: ${stderr || stdout}`);
  }
  return stdout ? JSON.parse(stdout) : null;
}
function splitConcatenatedJson(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0;i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped)
        escaped = false;
      else if (c === "\\")
        escaped = true;
      else if (c === '"')
        inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return results;
}
function ghPaginated(...args) {
  const { code, stdout, stderr } = gh(...args, "--paginate");
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} --paginate: ${stderr || stdout}`);
  }
  if (!stdout.trim())
    return [];
  const flat = [];
  for (const page of splitConcatenatedJson(stdout)) {
    if (Array.isArray(page))
      flat.push(...page);
  }
  return flat;
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

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/fetch_events.ts
var ref = defineScript(import.meta.url);
function repoParts() {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name)
    throw new Error(`GITHUB_REPOSITORY is not set or malformed: "${repo}"`);
  return [owner, name];
}
function contextList(what, ...args) {
  try {
    return ghPaginated(...args);
  } catch (error) {
    console.error(`::warning::Could not fetch ${what}: ${error.message}. Continuing without it \u2014 the run has less context than usual.`);
    return [];
  }
}
function requiredJson(what, ...args) {
  const { code, stdout, stderr } = ghRead(...args);
  if (code !== 0) {
    throw new Error(`Could not fetch ${what}, which a run cannot proceed without: ${stderr || stdout}`);
  }
  return JSON.parse(stdout);
}
function fetchIssueEvents(owner, repo, issueNum, openedType, commentType, idPrefix) {
  const issue = requiredJson(`issue #${issueNum}`, "api", `repos/${owner}/${repo}/issues/${issueNum}`);
  const labelsLine = issue.labels.length > 0 ? `**Labels:** ${issue.labels.map((l) => l.name).join(", ")}
` : "";
  const openedEvent = {
    id: `${idPrefix}-${issue.number}`,
    event_type: openedType,
    content: `Issue #${issue.number}: ${issue.title}
${labelsLine}
${issue.body ?? ""}`,
    author: issue.user.login,
    created_at: issue.created_at
  };
  const comments = contextList(`comments on #${issueNum}`, "api", `repos/${owner}/${repo}/issues/${issueNum}/comments`);
  const commentEvents = comments.map((c) => ({
    id: c.id,
    event_type: commentType,
    content: c.body,
    author: c.user.login,
    created_at: c.created_at
  }));
  return [openedEvent, ...commentEvents];
}
function fetchPrEvents(owner, repo, number, maxDiffChars) {
  const pr = requiredJson(`pull request #${number}`, "api", `repos/${owner}/${repo}/pulls/${number}`);
  const prBody = pr.body ?? "";
  const parentIssue = PARENT_ISSUE_TAG.read(prBody);
  const headSha = pr.head.sha.slice(0, 8);
  const events = [];
  const labelsLine = pr.labels.length > 0 ? `**Labels:** ${pr.labels.map((label) => label.name).join(", ")}` : "";
  const linkedLine = parentIssue ? `**Linked Issue:** #${parentIssue}` : "";
  const prContentLines = [`PR #${number}: ${pr.title}`, labelsLine, linkedLine].filter(Boolean);
  prContentLines.push("", prBody);
  events.push({
    id: `pr-${number}`,
    event_type: "pr_opened",
    content: prContentLines.join(`
`),
    author: pr.user.login,
    created_at: pr.created_at
  });
  const diffResult = gh("api", `repos/${owner}/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff");
  const diff = diffResult.code === 0 ? diffResult.stdout : "";
  if (diff) {
    const truncated = diff.slice(0, maxDiffChars);
    let diffContent = "```diff\n" + truncated + "\n```";
    if (diff.length > maxDiffChars)
      diffContent += `

*[Diff truncated at ${maxDiffChars} characters due to size]*`;
    events.push({
      id: `pr-${number}-diff`,
      event_type: "pr_diff",
      content: diffContent,
      sha: headSha,
      author: "github",
      created_at: pr.updated_at
    });
  }
  const prComments = contextList(`comments on #${number}`, "api", `repos/${owner}/${repo}/issues/${number}/comments`);
  events.push(...prComments.map((comment) => ({
    id: comment.id,
    event_type: "pr_comment",
    content: comment.body,
    author: comment.user.login,
    created_at: comment.created_at
  })));
  const reviews = contextList(`reviews on #${number}`, "api", `repos/${owner}/${repo}/pulls/${number}/reviews`);
  events.push(...reviews.filter((review) => review.submitted_at != null).map((review) => ({
    id: `pr-review-${review.id}`,
    event_type: "pr_review",
    content: `Review state: ${review.state}

${review.body ?? ""}`,
    author: review.user.login,
    created_at: review.submitted_at
  })));
  const inlineComments = contextList(`inline review comments on #${number}`, "api", `repos/${owner}/${repo}/pulls/${number}/comments`);
  events.push(...inlineComments.map((comment) => ({
    id: comment.id,
    event_type: "pr_review_comment",
    content: `On \`${comment.path}\` line ${comment.line ?? comment.original_line ?? "?"}:

${comment.body}`,
    author: comment.user.login,
    created_at: comment.created_at
  })));
  return { events, parentIssue };
}
function linkedPrNumbers(owner, repo, issueNumber) {
  const prs = ghJson("pr", "list", "--repo", `${owner}/${repo}`, "--state", "all", "--search", `atoma:parent-issue=${issueNumber} in:body`, "--limit", "1000", "--json", "number") ?? [];
  if (prs.length === 1000) {
    console.error(`::warning::Linked PR search for Issue #${issueNumber} reached GitHub's 1000-result search limit.`);
  }
  return prs.map((pr) => pr.number);
}
function tryLinkedPrNumbers(owner, repo, issueNumber) {
  try {
    return linkedPrNumbers(owner, repo, issueNumber);
  } catch {
    console.error(`::warning::Could not search linked PRs for Issue #${issueNumber}; using the available context.`);
    return [];
  }
}
function appendPrEvents(events, owner, repo, prNumber, maxDiffChars) {
  try {
    events.push(...fetchPrEvents(owner, repo, prNumber, maxDiffChars).events);
  } catch {
    console.error(`::warning::Could not fetch linked PR #${prNumber}; skipping it.`);
  }
}
function fetchEvents(type, number, maxDiffChars) {
  const [owner, repo] = repoParts();
  if (type === "issue") {
    const events2 = fetchIssueEvents(owner, repo, number, "issue_opened", "issue_comment", "issue");
    for (const prNumber of tryLinkedPrNumbers(owner, repo, number)) {
      appendPrEvents(events2, owner, repo, prNumber, maxDiffChars);
    }
    events2.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { events: events2, resolvedType: "issue", resolvedNumber: number };
  }
  const prResult = fetchPrEvents(owner, repo, number, maxDiffChars);
  let events = [...prResult.events];
  if (prResult.parentIssue) {
    try {
      events = fetchIssueEvents(owner, repo, prResult.parentIssue, "issue_opened", "issue_comment", "issue");
      const relatedPrNumbers = new Set([number, ...tryLinkedPrNumbers(owner, repo, prResult.parentIssue)]);
      for (const relatedPrNumber of relatedPrNumbers) {
        if (relatedPrNumber === number)
          events.push(...prResult.events);
        else
          appendPrEvents(events, owner, repo, relatedPrNumber, maxDiffChars);
      }
    } catch {
      console.error(`::warning::Linked Issue #${prResult.parentIssue} not found or inaccessible \u2014 using PR-local context.`);
      events.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { events, resolvedType: "pr", resolvedNumber: number };
    }
  }
  events.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    events,
    resolvedType: prResult.parentIssue ? "issue" : "pr",
    resolvedNumber: prResult.parentIssue ?? number
  };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      "max-diff-chars": { type: "string" },
      out: { type: "string" }
    }
  });
  if (values.type !== "issue" && values.type !== "pr" || !values.number || !values.out) {
    console.error("usage: fetch_events.ts --type issue|pr --number N [--max-diff-chars N] --out events.json");
    process.exit(2);
  }
  const maxDiffChars = Number(values["max-diff-chars"] ?? 30000);
  const { events, resolvedType, resolvedNumber } = fetchEvents(values.type, Number(values.number), maxDiffChars);
  writeFileSync(values.out, JSON.stringify(events, null, 2));
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput)
    appendFileSync(githubOutput, `resolved_type=${resolvedType}
resolved_number=${resolvedNumber}
`);
  console.error(`Fetched ${events.length} events \u2192 ${values.out}`);
}
if (import.meta.main)
  main();
export {
  fetchEvents,
  ref
};
