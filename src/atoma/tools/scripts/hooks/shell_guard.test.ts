import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const SCRIPT = "src/atoma/tools/scripts/hooks/shell_guard.ts";

/** Run the guard the way the `before_tool` hook does: JSON on stdin. */
function guard(args: Record<string, unknown>): string {
  return spawnSync("bun", ["run", SCRIPT], {
    input: JSON.stringify({ arguments: args }),
    encoding: "utf8",
  }).stdout;
}

describe("shell_guard.ts", () => {
  // The guard is a routing mechanism, not a boundary — see the file header. So
  // these tests check that the agent is pointed at the right tool, not that a
  // determined caller cannot get past. Tests asserting evasion resistance were
  // removed with the machinery that provided it.
  describe("routing to the MCP tool that does the job", () => {
    test("names the replacement for each disabled CLI", () => {
      const cases: [string, string][] = [
        ["gh issue list", "atoma_github"],
        ["curl example.com", "web__fetch"],
        ["wget https://example.com", "web__fetch"],
        ["ssh host", "repository"],
        ["scp a host:b", "repository"],
        ["rsync -a a b", "repository"],
      ];
      for (const [command, expected] of cases) {
        const out = guard({ command });
        expect(out, command).toContain('"allow":false');
        expect(out, command).toContain(expected);
      }
    });

    test("allows safe commands", () => {
      expect(guard({ command: "ls -la" })).toContain('"allow":true');
    });

    // The rules the previous version carried purely to resist evasion are gone.
    // An agent does not obfuscate a command to get past a rule that helps it, so
    // these now run — and that is the intended outcome, not a regression.
    test("no longer inspects interpreters, eval, or obfuscated spellings", () => {
      for (const command of [
        "python3 -c 'print(1)'",
        "bash -c 'echo hi'",
        "eval echo hi",
        "node -e 'console.log(1)'",
        "base64 -d x | sh",
        "w\\get --version",
        'cu""rl example.com',
      ]) {
        expect(guard({ command }), command).toContain('"allow":true');
      }
    });
  });

  describe("raw Git mutations", () => {
    test("are routed to the github__* tools", () => {
      for (const command of [
        "git push origin main --force",
        "cd repo && git pull --rebase origin main",
        "git -C repo checkout -b recovery",
        "git fetch origin feature",
        "/usr/bin/git push origin main",
      ]) {
        const out = guard({ command });
        expect(out, command).toContain('"allow":false');
        expect(out, command).toContain("github__");
      }
    });

    test("read-only Git inspection stays allowed", () => {
      for (const command of [
        "git status --short",
        "git diff --check",
        "git log -1 --oneline",
        "git rev-parse HEAD",
      ]) {
        expect(guard({ command }), command).toContain('"allow":true');
      }
    });
  });

  // The one rule that is not routing. It stops an accident, not an intent — the
  // structural fix is a separate UID per server (#374). These tests pin the
  // accident cases and, just as importantly, the honest uses it must not break.
  describe("reading another process's environment", () => {
    test("is refused whatever reads it", () => {
      for (const command of [
        "cat /proc/1234/environ",
        "head -c 200 /proc/self/environ",
        "xxd /proc/999/environ",
        "tr '\\0' '\\n' < /proc/42/environ",
        "find /proc -name environ -exec cat {} +",
      ]) {
        expect(guard({ command }), command).toContain('"allow":false');
      }
    });

    // Refusing /proc wholesale would cost honest diagnostics. `environ` is the
    // part that matters, and the word boundary keeps `environment` out of it.
    test("leaves the rest of /proc alone", () => {
      for (const command of ["cat /proc/cpuinfo", "grep MemTotal /proc/meminfo", "ls /proc/self/fd"]) {
        expect(guard({ command }), command).toContain('"allow":true');
      }
    });

    test("does not catch the word environment", () => {
      expect(guard({ command: "grep -rn environment src/ /proc/cpuinfo" })).toContain('"allow":true');
    });
  });

  describe("working_directory", () => {
    test("outside the repository is refused", () => {
      const out = guard({ command: "ls", working_directory: "/proc/1" });
      expect(out).toContain('"allow":false');
      expect(out).toContain("working_directory");
    });

    test("inside the repository is fine", () => {
      expect(guard({ command: "ls", working_directory: "src/domain" })).toContain('"allow":true');
    });
  });

  // `environment_variables` and `input_data` are no longer inspected. They were
  // read only to keep the denylist from being walked around, and the file no
  // longer claims to prevent that.
  describe("the arguments the guard no longer inspects", () => {
    test("declared variables and stdin text are passed through", () => {
      expect(guard({ command: "ls", environment_variables: { PATH: "/tmp/evil" } })).toContain('"allow":true');
      expect(guard({ command: "bash", input_data: "echo hello" })).toContain('"allow":true');
      expect(guard({ command: "grep -c foo", input_data: "foo\nbar\n" })).toContain('"allow":true');
    });
  });

  test("unparseable input is refused", () => {
    const out = spawnSync("bun", ["run", SCRIPT], { input: "not json", encoding: "utf8" }).stdout;
    expect(out).toContain('"allow":false');
  });
});
