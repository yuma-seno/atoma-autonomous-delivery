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
function fetchIssueEvents(owner, repo, issueNum, openedType, commentType, idPrefix) {
  const issue = JSON.parse(gh("api", `repos/${owner}/${repo}/issues/${issueNum}`).stdout);
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
  const comments = ghPaginated("api", `repos/${owner}/${repo}/issues/${issueNum}/comments`);
  const commentEvents = comments.map((c) => ({
    id: c.id,
    event_type: commentType,
    content: c.body,
    author: c.user.login,
    created_at: c.created_at
  }));
  return [openedEvent, ...commentEvents];
}
function fetchEvents(type, number, maxDiffChars) {
  const [owner, repo] = repoParts();
  if (type === "issue") {
    const events2 = fetchIssueEvents(owner, repo, number, "issue_opened", "issue_comment", "issue");
    events2.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { events: events2, resolvedNumber: number };
  }
  const pr = JSON.parse(gh("api", `repos/${owner}/${repo}/pulls/${number}`).stdout);
  const prBody = pr.body ?? "";
  const headSha = pr.head.sha.slice(0, 8);
  const linkedMatch = /<!--\s*atoma-linked-issue:\s*(\d+)\s*-->/.exec(prBody);
  let linkedIssue = linkedMatch ? Number(linkedMatch[1]) : undefined;
  let resolvedNumber = linkedIssue ?? number;
  const events = [];
  if (linkedIssue) {
    try {
      events.push(...fetchIssueEvents(owner, repo, linkedIssue, "linked_issue_opened", "linked_issue_comment", "linked-issue"));
    } catch {
      console.error(`::warning::Linked Issue #${linkedIssue} not found or inaccessible \u2014 skipping.`);
      linkedIssue = undefined;
      resolvedNumber = number;
    }
  }
  const labelsLine = pr.labels.length > 0 ? `**Labels:** ${pr.labels.map((l) => l.name).join(", ")}` : "";
  const linkedLine = linkedIssue ? `**Linked Issue:** #${linkedIssue}` : "";
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
    if (diff.length > maxDiffChars) {
      diffContent += `

*[Diff truncated at ${maxDiffChars} characters due to size]*`;
    }
    events.push({
      id: `pr-${number}-diff`,
      event_type: "pr_diff",
      content: diffContent,
      sha: headSha,
      author: "github",
      created_at: pr.updated_at
    });
  }
  const prComments = ghPaginated("api", `repos/${owner}/${repo}/issues/${number}/comments`);
  events.push(...prComments.map((c) => ({
    id: c.id,
    event_type: "pr_comment",
    content: c.body,
    author: c.user.login,
    created_at: c.created_at
  })));
  const reviews = ghPaginated("api", `repos/${owner}/${repo}/pulls/${number}/reviews`);
  events.push(...reviews.filter((r) => r.submitted_at != null).map((r) => ({
    id: `pr-review-${r.id}`,
    event_type: "pr_review",
    content: `Review state: ${r.state}

${r.body ?? ""}`,
    author: r.user.login,
    created_at: r.submitted_at
  })));
  const inlineComments = ghPaginated("api", `repos/${owner}/${repo}/pulls/${number}/comments`);
  events.push(...inlineComments.map((c) => ({
    id: c.id,
    event_type: "pr_review_comment",
    content: `On \`${c.path}\` line ${c.line ?? c.original_line ?? "?"}:

${c.body}`,
    author: c.user.login,
    created_at: c.created_at
  })));
  events.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { events, resolvedNumber };
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
  const { events, resolvedNumber } = fetchEvents(values.type, Number(values.number), maxDiffChars);
  writeFileSync(values.out, JSON.stringify(events, null, 2));
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput)
    appendFileSync(githubOutput, `resolved_number=${resolvedNumber}
`);
  console.error(`Fetched ${events.length} events \u2192 ${values.out}`);
}
if (import.meta.main)
  main();
export {
  ref,
  fetchEvents
};
