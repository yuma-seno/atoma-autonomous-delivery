import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toArgv } from "./lib/cli.ts";
import { buildArgv } from "./get_config_value.ts";

const SCRIPTS_DIR = "src/scripts";

// Scripts that read config via a cwd-relative path (e.g. `.github/atoma/config.json`)
// are designed to run with cwd = the deployed repo root -- which, for this
// repo's own dev/test purposes (before anything is copied anywhere), is
// `dist/`. Spawn with cwd set there and an absolute script path so the
// relative `bun run <script>` argument still resolves correctly.
function runScript(name: string, env: Record<string, string> = {}) {
  return spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, name)], {
    encoding: "utf8",
    cwd: join(process.cwd(), "dist"),
    env: { ...process.env, ...env },
  });
}

function parseGithubOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("match_trigger.ts", () => {
  test("PR opened -> reviewer", () => {
    const r = runScript("match_trigger.ts", { EVENT_TYPE: "pull_request.opened" });
    expect(r.stdout.trim()).toBe("reviewer");
  });

  test("changes_requested -> engineer", () => {
    const r = runScript("match_trigger.ts", {
      EVENT_TYPE: "pull_request_review.submitted",
      REVIEW_STATE: "changes_requested",
    });
    expect(r.stdout.trim()).toBe("engineer");
  });

  test("approved -> no match", () => {
    const r = runScript("match_trigger.ts", {
      EVENT_TYPE: "pull_request_review.submitted",
      REVIEW_STATE: "approved",
    });
    expect(r.stdout.trim()).toBe("");
  });
});

describe("config.json", () => {
  test("is valid and matches expected shape", async () => {
    const c = await Bun.file("dist/.github/atoma/config.json").json();
    expect(c.version).toBe(4);
    expect(c.agents.orchestrator.max_iterations).toBe(100);
    expect(c.merge_policy).toBe("auto");
    expect(c.labels).toBeDefined();
  });
});

describe("lib/cli.ts toArgv", () => {
  test("builds quoted --flag value pairs, skipping undefined", () => {
    expect(toArgv({ repo: "owner/repo", parent: 5, empty: undefined })).toEqual(["--repo", '"owner/repo"', "--parent", '"5"']);
  });
});

describe("get_config_value.ts buildArgv", () => {
  test("quotes path and fallback", () => {
    expect(buildArgv("agents.engineer.max_iterations", "30")).toEqual(['"agents.engineer.max_iterations"', '"30"']);
  });
  test("omits fallback when not given", () => {
    expect(buildArgv("labels.in_progress")).toEqual(['"labels.in_progress"']);
  });
});

describe("extract_notify_tag.ts", () => {
  test("extracts the notify tag from a PR body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    const r = spawnSync("bun", ["run", `${SCRIPTS_DIR}/extract_notify_tag.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "<!-- atoma:notify=octocat -->\nsome body", GITHUB_OUTPUT: outputFile },
    });
    expect(r.status).toBe(0);
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.notify).toBe("octocat");
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty when no tag present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/extract_notify_tag.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "no tag here", GITHUB_OUTPUT: outputFile },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.notify).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parse_pr_metadata.ts", () => {
  test("parses parent-issue and Closes # references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/parse_pr_metadata.ts`], {
      encoding: "utf8",
      env: {
        ...process.env,
        PR_BODY: "<!-- atoma:parent-issue=42 -->\nCloses #7\nsome body",
        PR_NUMBER: "99",
        GITHUB_OUTPUT: outputFile,
      },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.parent_number).toBe("42");
    expect(out.sub_number).toBe("7");
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty outputs when no metadata present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/parse_pr_metadata.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "plain body", PR_NUMBER: "1", GITHUB_OUTPUT: outputFile },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.parent_number).toBe("");
    expect(out.sub_number).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolve_entry_agent.ts", () => {
  test("emits agent/number/type/notify when body starts with a slash command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const eventFile = join(dir, "event.json");
    const outputFile = join(dir, "out");
    writeFileSync(eventFile, JSON.stringify({ issue: { body: "/orchestrator\n\nDo the thing." } }));
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/resolve_entry_agent.ts`], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_OUTPUT: outputFile,
        NUMBER: "123",
        SENDER: "octocat",
      },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.agent).toBe("orchestrator");
    expect(out.number).toBe("123");
    expect(out.type).toBe("issue");
    expect(out.notify).toBe("octocat");
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes nothing when body has no slash command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const eventFile = join(dir, "event.json");
    const outputFile = join(dir, "out");
    writeFileSync(eventFile, JSON.stringify({ issue: { body: "just a regular issue" } }));
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/resolve_entry_agent.ts`], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, NUMBER: "1", SENDER: "x" },
    });
    const out = await Bun.file(outputFile).text();
    expect(out.trim()).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});
