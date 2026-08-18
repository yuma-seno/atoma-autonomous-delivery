#!/usr/bin/env bun
// @bun

// src/scripts/validate_pull_request.ts
import { appendFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/pr-validation.ts
var PASSING = new Set(["success", "skipped", "neutral"]);
var CI_RETRY_LIMIT = 3;
function decideValidationOutcome(conclusion, requiredContexts, reviewerAgent, engineerAgent, priorRetries = 0) {
  const normalised = conclusion.trim().toLowerCase();
  const passed = PASSING.has(normalised);
  const checks = requiredContexts.map((name) => ({
    name,
    conclusion: passed ? "success" : "failure"
  }));
  if (passed) {
    return { checks, nextAgent: reviewerAgent, summary: `CI concluded ${normalised}.` };
  }
  if (!normalised) {
    return {
      checks,
      nextAgent: "",
      summary: "CI never reported a conclusion. Nothing was dispatched; a human should look."
    };
  }
  if (priorRetries >= CI_RETRY_LIMIT) {
    return {
      checks,
      nextAgent: "",
      summary: `CI concluded ${normalised} after ${priorRetries} attempts at fixing it. ` + `Stopping rather than dispatching the engineer again; a human should look.`
    };
  }
  return {
    checks,
    nextAgent: engineerAgent,
    summary: `CI concluded ${normalised}. Returning to the engineer with the failing job.`
  };
}

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

// src/lib/branch-rules.ts
function readRequiredChecks(repo, baseRef) {
  if (!baseRef)
    return { known: false, why: "no base branch was given" };
  const { code, stdout } = gh("api", `repos/${repo}/rules/branches/${baseRef}`);
  if (code)
    return { known: false, why: `the branch rules for ${baseRef} could not be read` };
  try {
    const rules = JSON.parse(stdout || "[]");
    return {
      known: true,
      contexts: rules.filter((rule) => rule.type === "required_status_checks").flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((check) => check.context)
    };
  } catch {
    return { known: false, why: `the branch rules for ${baseRef} were not valid JSON` };
  }
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
var CI_RETRY_TAG = numericTag("ci-retry");

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/validate_pull_request.ts
var ref = defineScript(import.meta.url);
function log(message) {
  console.error(`[atoma-validate-pr] ${message}`);
}
function pickDispatchedRun(runs, headSha, since) {
  const candidates = runs.filter((run3) => run3.event === "workflow_dispatch").filter((run3) => run3.head_sha === headSha).filter((run3) => run3.created_at >= since).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  const run2 = candidates[0];
  return run2 ? { id: run2.id, status: run2.status, conclusion: run2.conclusion } : undefined;
}
function countPriorRetries(repo, number) {
  const { code, stdout } = gh("api", `repos/${repo}/issues/${number}/comments?per_page=100`);
  if (code)
    return 0;
  try {
    const comments = JSON.parse(stdout || "[]");
    return comments.filter((c) => CI_RETRY_TAG.has(c.body ?? "")).length;
  } catch {
    return 0;
  }
}
function reportFailure(repo, number, attempt, runUrl, summary) {
  const body = [
    LLM_CONTEXT_TAG.write("include"),
    CI_RETRY_TAG.write(attempt),
    `Atoma: ${summary}`,
    "",
    runUrl ? `Failing run: ${runUrl}` : ""
  ].filter(Boolean).join(`
`);
  const posted = gh("issue", "comment", number, "--repo", repo, "--body", body);
  if (posted.code)
    log(`WARN could not post the failure comment: ${posted.stderr}`);
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      number: { type: "string" },
      branch: { type: "string" },
      workflow: { type: "string" },
      reviewer: { type: "string" },
      engineer: { type: "string" },
      "timeout-seconds": { type: "string" }
    }
  });
  const repo = values.repo ?? "";
  const branch = values.branch ?? "";
  const workflow = values.workflow ?? "";
  if (!repo || !branch || !workflow) {
    console.error("usage: validate_pull_request.ts --repo owner/name --number N --branch B --workflow W");
    process.exit(1);
  }
  const githubOutput = process.env.GITHUB_OUTPUT;
  const write = (line) => {
    if (githubOutput)
      appendFileSync(githubOutput, `${line}
`);
  };
  const prJson = gh("api", `repos/${repo}/pulls/${values.number}`).stdout;
  const pr = JSON.parse(prJson || "{}");
  const headSha = pr.head?.sha ?? "";
  const baseRef = pr.base?.ref ?? "";
  if (!headSha) {
    log("could not read the pull request's head SHA");
    process.exit(1);
  }
  const required = readRequiredChecks(repo, baseRef);
  if (!required.known) {
    log(`cannot validate: ${required.why}`);
    process.exit(1);
  }
  const requiredContexts = required.contexts;
  log(`required contexts on ${baseRef}: ${requiredContexts.join(", ") || "(none)"}`);
  if (requiredContexts.length === 0) {
    log(`::warning::${baseRef} requires no status checks, so CI results gate nothing here. ` + "Import .github/atoma/rulesets/main.json if that was not intended.");
  }
  const since = new Date().toISOString();
  const dispatch = gh("workflow", "run", workflow, "--repo", repo, "--ref", branch);
  if (dispatch.code) {
    log(`could not dispatch ${workflow} against ${branch}: ${dispatch.stderr}`);
    process.exit(1);
  }
  const timeoutSeconds = Number(values["timeout-seconds"] ?? "1800");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let conclusion = "";
  let runUrl = "";
  while (Date.now() < deadline) {
    Bun.sleepSync(1e4);
    const listed = gh("api", `repos/${repo}/actions/runs?per_page=30&event=workflow_dispatch`).stdout;
    const { workflow_runs = [] } = JSON.parse(listed || "{}");
    const run2 = pickDispatchedRun(workflow_runs, headSha, since);
    if (!run2)
      continue;
    if (run2.status !== "completed")
      continue;
    conclusion = run2.conclusion ?? "";
    runUrl = `https://github.com/${repo}/actions/runs/${run2.id}`;
    log(`dispatched run ${run2.id} concluded ${conclusion}`);
    break;
  }
  if (!conclusion)
    log(`no conclusion within ${timeoutSeconds}s`);
  const priorRetries = countPriorRetries(repo, values.number ?? "");
  const outcome = decideValidationOutcome(conclusion, requiredContexts, values.reviewer ?? "", values.engineer ?? "", priorRetries);
  for (const check of outcome.checks) {
    const created = gh("api", "--method", "POST", `repos/${repo}/check-runs`, "-f", `name=${check.name}`, "-f", `head_sha=${headSha}`, "-f", "status=completed", "-f", `conclusion=${check.conclusion}`);
    if (created.code)
      log(`WARN could not write check "${check.name}": ${created.stderr}`);
    else
      log(`wrote check "${check.name}" as ${check.conclusion}`);
  }
  const passed = outcome.checks.every((check) => check.conclusion === "success");
  if (!passed)
    reportFailure(repo, values.number ?? "", priorRetries + 1, runUrl, outcome.summary);
  write(`next_agent=${outcome.nextAgent}`);
  write(`conclusion=${conclusion}`);
  write(`summary=${outcome.summary}`);
}
if (import.meta.main)
  main();
export {
  ref,
  pickDispatchedRun
};
