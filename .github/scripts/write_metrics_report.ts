#!/usr/bin/env bun
// @bun

// src/scripts/write_metrics_report.ts
import { parseArgs } from "util";
import { readFileSync } from "fs";

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
function gitRun(...args) {
  return run(["git", ...args]);
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

// src/scripts/lib/atoma-data.ts
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
function gitIn(cwd, ...args) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "" };
}
function saveSession(targetPath, content, commitMessage) {
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0) {
    gitRun("config", "user.email", "action@github.com");
    gitRun("config", "user.name", "GitHub Actions");
    const commit = gitRun("commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "init: atoma-data session store").stdout;
    gitRun("push", "origin", `${commit}:refs/heads/atoma-data`);
  }
  gitRun("fetch", "origin", "atoma-data");
  const worktreeDir = mkdtempSync(join(tmpdir(), "atoma-data-wt-"));
  gitRun("worktree", "add", worktreeDir, "origin/atoma-data");
  let saved = false;
  try {
    gitIn(worktreeDir, "config", "user.email", "action@github.com");
    gitIn(worktreeDir, "config", "user.name", "GitHub Actions");
    for (let attempt = 1;attempt <= 5; attempt++) {
      gitIn(worktreeDir, "fetch", "origin", "atoma-data");
      gitIn(worktreeDir, "reset", "--hard", "origin/atoma-data");
      const fullTarget = join(worktreeDir, targetPath);
      mkdirSync(dirname(fullTarget), { recursive: true });
      writeFileSync(fullTarget, content);
      gitIn(worktreeDir, "add", targetPath);
      if (gitIn(worktreeDir, "diff", "--cached", "--quiet").code === 0) {
        saved = true;
        break;
      }
      gitIn(worktreeDir, "commit", "-m", commitMessage);
      if (gitIn(worktreeDir, "push", "origin", "HEAD:atoma-data").code === 0) {
        saved = true;
        break;
      }
      console.error(`Push attempt ${attempt} failed (concurrent push) -- resetting and retrying with a fresh pull...`);
      Bun.sleepSync(attempt * 2000);
    }
  } finally {
    gitRun("worktree", "remove", "--force", worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }
  return saved;
}

// src/domain/search-streak.ts
var SEARCHES = /^(grep|egrep|fgrep|rg|ag|ack|ugrep|find)$/;
var OPENS = /^(cat|bat|head|tail|sed|less|more|nl|od|xxd)$/;
function classifyShellAct(command) {
  const first = command.trim().split(/\s*(?:\|\||&&|[;|])\s*/)[0]?.trim().split(/\s+/).find((token) => token.length > 0 && !token.includes("=") && token !== "sudo" && token !== "time");
  if (first === undefined)
    return "other";
  const name = first.split("/").pop() ?? first;
  if (SEARCHES.test(name))
    return "search";
  if (OPENS.test(name))
    return "open";
  return "other";
}

// src/domain/metrics.ts
function distributionOf(values) {
  if (values.length === 0)
    return { p50: 0, p90: 0, p99: 0, max: 0, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return {
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    total: values.reduce((sum, v) => sum + v, 0)
  };
}
function tally(names) {
  const counts = new Map;
  for (const name of names)
    counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function metricsOf(sessions, declaredServers, declaredSkills, tokens) {
  const calls = sessions.flatMap((s) => s.calls);
  const byTool = new Map;
  for (const call of calls) {
    const row = byTool.get(call.tool) ?? { name: call.tool, count: 0, failed: 0 };
    row.count += 1;
    if (call.failed)
      row.failed += 1;
    byTool.set(call.tool, row);
  }
  const usedServers = new Set(calls.map((c) => c.tool.split("__")[0] ?? ""));
  const loaded = new Set(calls.flatMap((c) => c.skill ? [c.skill] : []));
  return {
    sessions: sessions.length,
    messages: distributionOf(sessions.map((s) => s.messages)),
    byAgent: tally(sessions.map((s) => s.agent)),
    byTool: [...byTool.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    bySkill: tally(calls.flatMap((c) => c.skill ? [c.skill] : [])),
    byAct: tally(calls.flatMap((c) => c.act ? [c.act] : [])),
    neverUsedServers: declaredServers.filter((s) => !usedServers.has(s)).sort(),
    neverLoaded: declaredSkills.filter((s) => !loaded.has(s)).sort(),
    refusals: calls.filter((c) => c.refused).length,
    runs: sessions.flatMap((s) => s.runs),
    tokens: tokens.length === 0 ? undefined : tokenSummary(tokens)
  };
}
function tokenSummary(tokens) {
  const total = tokens.reduce((sum, t) => sum + t.total, 0);
  const prompt = tokens.reduce((sum, t) => sum + t.prompt, 0);
  return {
    runs: tokens.length,
    total,
    perRun: distributionOf(tokens.map((t) => t.total)),
    promptShare: total === 0 ? 0 : prompt / total
  };
}

// src/domain/metrics-windows.ts
var WINDOWS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "All time" }
];
function within(run, window, now) {
  if (window.days === undefined)
    return true;
  const ended = Date.parse(run.ended);
  if (Number.isNaN(ended))
    return false;
  return now.getTime() - ended <= window.days * 86400000;
}
function endings(runs) {
  const counts = new Map;
  for (const run of runs)
    counts.set(run.ended_because, (counts.get(run.ended_because) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function gaveUpShare(runs) {
  if (runs.length === 0)
    return 0;
  return runs.filter((r) => r.ended_because !== "completed").length / runs.length;
}

// src/domain/metrics-report.ts
function runSection(runs, now) {
  const out = ["## Runs", ""];
  if (runs.length === 0) {
    out.push("No run has recorded itself yet. Atoma writes `atoma_runs` into a session from " + "v0.1.28; sessions older than that carry no times, and there is no way to backfill " + "one that would not be a guess.", "");
    return out;
  }
  out.push("| window | runs | gave up | median seconds | longest |");
  out.push("| --- | ---: | ---: | ---: | ---: |");
  for (const window of WINDOWS) {
    const inside = runs.filter((run) => within(run, window, now));
    if (inside.length === 0) {
      out.push(`| ${window.label} | 0 | \u2014 | \u2014 | \u2014 |`);
      continue;
    }
    const seconds = inside.map((r) => r.seconds).sort((a, b) => a - b);
    const median = seconds[Math.floor(seconds.length / 2)] ?? 0;
    const share = Math.round(gaveUpShare(inside) * 1000) / 10;
    const longest = seconds[seconds.length - 1] ?? 0;
    out.push(`| ${window.label} | ${n(inside.length)} | ${share}% | ${n(median)} | ${n(longest)} |`);
  }
  out.push("");
  out.push("**Gave up** is every ending that is not `completed` \u2014 a ceiling reached, a person " + "asking, a provider hanging up, a loop cut short. Each one is a mechanism deciding " + "the run should not continue, which is worth watching whether or not it was right.");
  out.push("");
  out.push("| ended because | runs |");
  out.push("| --- | ---: |");
  for (const row of endings(runs))
    out.push(`| \`${row.name}\` | ${n(row.count)} |`);
  out.push("");
  return out;
}
function n(value) {
  return value.toLocaleString("en-US");
}
function distributionRow(label, d) {
  return `| ${label} | ${n(d.p50)} | ${n(d.p90)} | ${n(d.p99)} | ${n(d.max)} | ${n(d.total)} |`;
}
function tallyTable(rows, of, what, unit) {
  if (rows.length === 0)
    return [`No ${what} recorded.`];
  const out = [`| ${what} | ${unit} | share |`, "| --- | ---: | ---: |"];
  for (const row of rows) {
    const share = of === 0 ? 0 : Math.round(row.count / of * 1000) / 10;
    out.push(`| \`${row.name}\` | ${n(row.count)} | ${share}% |`);
  }
  return out;
}
function renderReport(metrics, now) {
  const out = [];
  out.push("# Agent metrics");
  out.push("");
  out.push(`Read from ${n(metrics.sessions)} stored sessions on this branch. Nothing here is recorded ` + "specially: every number is something the agents already wrote down while working.");
  out.push("");
  out.push(`Generated ${now.toISOString().slice(0, 10)}.`);
  out.push("");
  out.push(...runSection(metrics.runs, now));
  if (metrics.tokens) {
    const t = metrics.tokens;
    out.push("## Tokens");
    out.push("");
    out.push(`${n(t.total)} tokens over ${n(t.runs)} runs that reported them. **${Math.round(t.promptShare * 1000) / 10}% of ` + "that is prompt** \u2014 what the agents were made to read, not what they wrote. Anything " + "spent on making runs cheaper belongs on that side.");
    out.push("");
    out.push("No money here, deliberately: of the four providers only one reports a cost, and a " + "price table goes quietly stale and then prints confident wrong numbers. Multiply by a " + "rate you know.");
    out.push("");
    out.push("| | p50 | p90 | p99 | max | total |");
    out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    out.push(distributionRow("tokens per run", t.perRun));
    out.push("");
  }
  out.push("## Sessions");
  out.push("");
  out.push("| | p50 | p90 | p99 | max | total |");
  out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  out.push(distributionRow("messages per session", metrics.messages));
  out.push("");
  out.push(...tallyTable(metrics.byAgent, metrics.sessions, "agent", "sessions"));
  out.push("");
  out.push("## Tools");
  out.push("");
  if (metrics.byTool.length === 0) {
    out.push("No tool calls recorded.");
  } else {
    out.push("Failure is counted by the result reading as an error, which is a string match and " + "so an estimate. A high rate is worth looking at either way: it is either a tool that " + "breaks or a tool the prompt points at wrongly.");
    out.push("");
    out.push("| tool | calls | failed | rate |");
    out.push("| --- | ---: | ---: | ---: |");
    for (const row of metrics.byTool) {
      const rate = row.count === 0 ? 0 : Math.round(row.failed / row.count * 1000) / 10;
      out.push(`| \`${row.name}\` | ${n(row.count)} | ${n(row.failed)} | ${rate}% |`);
    }
  }
  out.push("");
  out.push("### Servers never used");
  out.push("");
  out.push(metrics.neverUsedServers.length === 0 ? "Every declared server has been called at least once." : "Every tool a server offers is described in the prompt of every run. These have " + `never been called:

` + metrics.neverUsedServers.map((t) => `- \`${t}\``).join(`
`));
  out.push("");
  out.push("## Shell activity");
  out.push("");
  out.push("What the agents do when they reach for a shell. `search` without a matching `open` is " + "the shape that produced this project's most expensive runs; `edit` against `verify` is " + "the shape that turned out not to occur at all.");
  out.push("");
  out.push(...tallyTable(metrics.byAct, metrics.byAct.reduce((s, a) => s + a.count, 0), "act", "calls"));
  out.push("");
  out.push(`Hooks refused ${n(metrics.refusals)} calls.`);
  out.push("");
  out.push("## Skills");
  out.push("");
  out.push(...tallyTable(metrics.bySkill, metrics.bySkill.reduce((s, k) => s + k.count, 0), "skill", "loads"));
  out.push("");
  out.push("### Never loaded");
  out.push("");
  out.push(metrics.neverLoaded.length === 0 ? "Every skill has been loaded at least once." : "Each of these is described in the prompt of every run and has never been loaded. That " + `is either a skill nobody needs or one the prompt fails to point at:

` + metrics.neverLoaded.map((s) => `- \`${s}\``).join(`
`));
  out.push("");
  return out.join(`
`);
}

// src/scripts/write_metrics_report.ts
var ref = defineScript(import.meta.url);
var BRANCH = "atoma-data";
var REPORT_PATH = "metrics/report.md";
var ROWS_PATH = "metrics/rows.json";
function rowsOf(sessions) {
  return sessions.map((s) => {
    const tools = {};
    const acts = {};
    for (const call of s.calls) {
      tools[call.tool] = (tools[call.tool] ?? 0) + 1;
      if (call.act)
        acts[call.act] = (acts[call.act] ?? 0) + 1;
    }
    return {
      path: s.path,
      agent: s.agent,
      messages: s.messages,
      calls: s.calls.length,
      failed: s.calls.filter((c) => c.failed).length,
      refused: s.calls.filter((c) => c.refused).length,
      skills: s.calls.flatMap((c) => c.skill ? [c.skill] : []),
      tools,
      acts,
      runs: s.runs
    };
  });
}
function log(message) {
  console.error(`[metrics] ${message}`);
}
function agentOf(path) {
  const file = path.split("/").pop() ?? "";
  const stem = file.replace(/\.json$/, "").replace(/-\d+$/, "");
  const match = /(?:^|-)(orchestrator|engineer|reviewer)$/.exec(stem);
  return match?.[1] ?? "unknown";
}
function looksFailed(content) {
  return /^\s*(Error|error):/.test(content) || /"status"\s*:\s*"(failed|error)"/.test(content);
}
function looksRefused(content) {
  return /blocked by hook|shell_guard:|Tool blocked/.test(content);
}
function sessionFrom(path, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`${path} is not readable as JSON; skipping it`);
    return;
  }
  const messages = parsed.messages ?? [];
  const results = new Map;
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      results.set(message.tool_call_id, typeof message.content === "string" ? message.content : "");
    }
  }
  const calls = [];
  const agent = agentOf(path);
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const tool = call.function?.name ?? "";
      if (!tool)
        continue;
      const result = results.get(call.id ?? "") ?? "";
      let skill;
      let act;
      if (tool.endsWith("load_skill")) {
        try {
          skill = JSON.parse(call.function?.arguments ?? "{}").name;
        } catch {}
      } else if (tool.endsWith("shell_execute")) {
        try {
          const command = JSON.parse(call.function?.arguments ?? "{}").command ?? "";
          act = shellAct(command);
        } catch {
          act = "other";
        }
      }
      calls.push({ tool, agent, failed: looksFailed(result), refused: looksRefused(result), skill, act });
    }
  }
  const runs = Array.isArray(parsed.atoma_runs) ? parsed.atoma_runs : [];
  return { path, agent, messages: messages.length, calls, runs };
}
function shellAct(command) {
  if (/>\s*[^\s|&>]+/.test(command) && !/>\s*\/dev\/null/.test(command))
    return "edit";
  const head = command.trim().split(/\s*(?:\|\||&&|[;|])\s*/)[0] ?? "";
  const word = (head.trim().split(/\s+/).find((t) => t && !t.includes("=") && t !== "sudo" && t !== "time") ?? "").split("/").pop();
  if (word === "sed" && /\s-i\b/.test(command))
    return "edit";
  if (/^(bun|npm|npx|pnpm|yarn|cargo|go|pytest|python3?|make|tsc|jest|vitest|mvn|gradle|dotnet)$/.test(word ?? "")) {
    return "verify";
  }
  const classified = classifyShellAct(command);
  return classified === "other" ? "other" : classified;
}
function tokensReported(repo) {
  const comments = ghPaginated("api", `repos/${repo}/issues/comments?per_page=100`);
  const out = [];
  for (const comment of comments) {
    const match = /_Tokens:\s*([\d,]+)\s*total\s*\(([\d,]+)\s*prompt\s*\+\s*([\d,]+)\s*completion\)_/.exec(comment.body ?? "");
    if (!match)
      continue;
    const number = Number(/(\d+)$/.exec(comment.issue_url ?? "")?.[1] ?? 0);
    const toNumber = (s) => Number(s.replace(/,/g, ""));
    out.push({
      issue: number,
      total: toNumber(match[1]),
      prompt: toNumber(match[2]),
      completion: toNumber(match[3])
    });
  }
  return out;
}
function declared() {
  const root = process.env.ATOMA_MACHINERY_ROOT?.trim() || ".";
  const tools = [];
  const skills = [];
  try {
    const yaml = readFileSync(`${root}/.github/atoma/tools/tools.yaml`, "utf8");
    for (const line of yaml.split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
      if (match?.[1] && match[1] !== "hooks")
        tools.push(match[1]);
    }
  } catch {
    log("could not read tools.yaml; the report will not name unused tools");
  }
  const listed = gitRun("ls-files", `${root}/.github/atoma/skills`);
  for (const path of listed.stdout.split(`
`)) {
    const match = /skills\/(.+)\.md$/.exec(path.trim());
    if (match?.[1])
      skills.push(match[1]);
  }
  return { tools, skills };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { repo: { type: "string" }, stdout: { type: "boolean" } }
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (gitRun("fetch", "origin", BRANCH).code !== 0) {
    log(`${BRANCH} does not exist yet; nothing to report on`);
    return;
  }
  const listed = gitRun("ls-tree", "-r", "--name-only", `origin/${BRANCH}`, "--", "sessions");
  const paths = listed.stdout.split(`
`).map((s) => s.trim()).filter((s) => s.endsWith(".json"));
  const sessions = [];
  for (const path of paths) {
    const shown = gitRun("show", `origin/${BRANCH}:${path}`);
    if (shown.code !== 0)
      continue;
    const record = sessionFrom(path, shown.stdout);
    if (record)
      sessions.push(record);
  }
  let tokens = [];
  if (repo) {
    try {
      tokens = tokensReported(repo);
    } catch (error) {
      log(`could not read the reported tokens: ${error.message}`);
    }
  }
  const { tools, skills } = declared();
  const now = new Date;
  const report = renderReport(metricsOf(sessions, tools, skills, tokens), now);
  const runs = sessions.flatMap((s) => s.runs);
  log(`${sessions.length} sessions, ${runs.length} recorded runs, ${tokens.length} reporting tokens`);
  if (values.stdout) {
    console.log(report);
    return;
  }
  if (!saveSession(ROWS_PATH, `${JSON.stringify(rowsOf(sessions), null, 2)}
`, `atoma: metric rows from ${sessions.length} sessions`)) {
    log("could not write the rows; the report is unaffected");
  }
  if (!saveSession(REPORT_PATH, report, `atoma: metrics from ${sessions.length} sessions`)) {
    log("could not write the report; the run is unaffected");
  }
}
if (import.meta.main)
  main();
export {
  REPORT_PATH,
  ROWS_PATH,
  agentOf,
  ref
};
