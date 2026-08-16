import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolveDeployTargets } from "../domain/deploy-targets.ts";
import { makeConfigDir, scriptPath } from "./testing/harness.ts";
import { selectTargets } from "./run_deploy.ts";

const CONFIG = {
  deploy: {
    targets: [
      { name: "staging", on: "merge", commands: ["echo deployed-staging"] },
      { name: "production", on: "tag", tags: ["v*"], commands: ["echo deployed-production"] },
      { name: "rollback", on: "manual", commands: ["echo rolled-back"] },
    ],
  },
};

function run(args: string[], config: Record<string, unknown> = CONFIG) {
  const dir = makeConfigDir(config);
  try {
    return spawnSync("bun", ["run", scriptPath("run_deploy.ts"), ...args], { encoding: "utf8", cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("selectTargets", () => {
  const { targets } = resolveDeployTargets(CONFIG.deploy.targets);

  test("a named target wins over whatever the event would have chosen", () => {
    const selected = selectTargets(targets, { ref: "refs/tags/v1.0.0", trigger: "merge", target: "rollback" });
    expect(selected?.map((t) => t.name)).toEqual(["rollback"]);
  });

  test("an unknown name selects nothing at all, rather than something else", () => {
    expect(selectTargets(targets, { ref: "", trigger: "", target: "typo" })).toBeNull();
  });

  test("a merge selects the merge targets", () => {
    expect(selectTargets(targets, { ref: "refs/heads/main", trigger: "merge", target: "" })?.map((t) => t.name)).toEqual(
      ["staging"],
    );
  });

  test("a tag selects the targets that claim it", () => {
    expect(selectTargets(targets, { ref: "refs/tags/v2.0.0", trigger: "", target: "" })?.map((t) => t.name)).toEqual([
      "production",
    ]);
  });

  test("a branch push with no trigger selects nothing", () => {
    expect(selectTargets(targets, { ref: "refs/heads/main", trigger: "", target: "" })).toEqual([]);
  });
});

describe("run_deploy.ts", () => {
  test("runs the commands of the target a tag claimed", () => {
    const r = run(["--ref", "refs/tags/v1.0.0"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deployed-production");
    expect(r.stdout).not.toContain("deployed-staging");
  });

  test("runs the merge targets when dispatched after a merge", () => {
    const r = run(["--ref", "refs/heads/main", "--trigger", "merge"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deployed-staging");
  });

  // A repository tags things for reasons that have nothing to do with deploying.
  // A red run for each one teaches people to ignore the red.
  test("a tag nobody asked for is a clean exit", () => {
    const r = run(["--ref", "refs/tags/nightly-2026-08-17"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing to deploy");
  });

  test("names the target to the commands it runs", () => {
    const r = run(["--target", "staging"], {
      deploy: { targets: [{ name: "staging", on: "merge", commands: ["echo target=$ATOMA_DEPLOY_TARGET"] }] },
    });
    expect(r.stdout).toContain("target=staging");
  });

  test("an unknown target fails and lists the ones that exist", () => {
    const r = run(["--target", "typo"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stderr).toContain("staging");
  });

  test("a failing command ends the run with its exit code", () => {
    const r = run(["--target", "staging"], {
      deploy: { targets: [{ name: "staging", on: "merge", commands: ["echo starting", "exit 4", "echo after"] }] },
    });
    expect(r.status).toBe(4);
    expect(r.stdout).not.toContain("after");
  });

  // Deploying the rest with one already broken puts more of the estate in an
  // unknown state, not less.
  test("a failing target stops the ones after it", () => {
    const r = run(["--trigger", "merge", "--ref", "refs/heads/main"], {
      deploy: {
        targets: [
          { name: "first", on: "merge", commands: ["exit 1"] },
          { name: "second", on: "merge", commands: ["echo second-ran"] },
        ],
      },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("second-ran");
  });

  test("an unusable target list fails before deploying anything", () => {
    const r = run(["--trigger", "merge", "--ref", "refs/heads/main"], {
      deploy: { targets: [{ name: "staging", on: "whenever", commands: ["echo x"] }] },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stdout).not.toContain("x");
  });

  test("no deploy configuration at all is a clean exit", () => {
    const r = run(["--ref", "refs/tags/v1.0.0"], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing to deploy");
  });
});
