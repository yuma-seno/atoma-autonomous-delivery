#!/usr/bin/env bun
// @bun

// src/scripts/validate_pull_request.ts
import { appendFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/pr-validation.ts
var PASSING = new Set(["success", "skipped", "neutral"]);
function decideValidationOutcome(conclusion, requiredContexts, reviewerAgent, engineerAgent) {
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
function readRequiredChecks(repo, baseRef) {
  const { code, stdout } = gh("api", `repos/${repo}/rules/branches/${baseRef}`);
  if (code) {
    log(`WARN could not read branch rules for ${baseRef}; no checks will be written`);
    return [];
  }
  try {
    const rules = JSON.parse(stdout || "[]");
    return rules.filter((rule) => rule.type === "required_status_checks").flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((check) => check.context);
  } catch {
    log(`WARN branch rules for ${baseRef} were not valid JSON`);
    return [];
  }
}
function pickDispatchedRun(runs, headSha, since) {
  const candidates = runs.filter((run3) => run3.event === "workflow_dispatch").filter((run3) => run3.head_sha === headSha).filter((run3) => run3.created_at >= since).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  const run2 = candidates[0];
  return run2 ? { id: run2.id, status: run2.status, conclusion: run2.conclusion } : undefined;
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
  const requiredContexts = readRequiredChecks(repo, baseRef);
  log(`required contexts on ${baseRef}: ${requiredContexts.join(", ") || "(none)"}`);
  const since = new Date().toISOString();
  const dispatch = gh("workflow", "run", workflow, "--repo", repo, "--ref", branch);
  if (dispatch.code) {
    log(`could not dispatch ${workflow} against ${branch}: ${dispatch.stderr}`);
    process.exit(1);
  }
  const timeoutSeconds = Number(values["timeout-seconds"] ?? "1800");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let conclusion = "";
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
    log(`dispatched run ${run2.id} concluded ${conclusion}`);
    break;
  }
  if (!conclusion)
    log(`no conclusion within ${timeoutSeconds}s`);
  const outcome = decideValidationOutcome(conclusion, requiredContexts, values.reviewer ?? "", values.engineer ?? "");
  for (const check of outcome.checks) {
    const created = gh("api", "--method", "POST", `repos/${repo}/check-runs`, "-f", `name=${check.name}`, "-f", `head_sha=${headSha}`, "-f", "status=completed", "-f", `conclusion=${check.conclusion}`);
    if (created.code)
      log(`WARN could not write check "${check.name}": ${created.stderr}`);
    else
      log(`wrote check "${check.name}" as ${check.conclusion}`);
  }
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
