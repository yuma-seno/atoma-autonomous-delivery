import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const SCRIPT = "src/atoma/tools/scripts/hooks/shell_guard.ts";

describe("shell_guard.ts", () => {
  test("blocks dangerous commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: "gh issue list" } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":false');
  });

  test("allows safe commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: "ls -la" } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":true');
  });

  test("blocks raw Git mutations while allowing read-only Git inspection", () => {
    for (const command of [
      "git push origin main --force",
      "cd repo && git pull --rebase origin main",
      "git -C repo checkout -b recovery",
      "git fetch origin feature",
      "/usr/bin/git push origin main",
    ]) {
      const blocked = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command } }),
        encoding: "utf8",
      });
      expect(blocked.stdout, command).toContain('"allow":false');
    }

    for (const command of ["git status --short", "git diff --check", "git log -1 --oneline", "git rev-parse HEAD"]) {
      const allowed = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command } }),
        encoding: "utf8",
      });
      expect(allowed.stdout, command).toContain('"allow":true');
    }
  });

  test("blocks backslash-obfuscated dangerous commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: "w\\get --version" } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":false');
  });

  test("blocks quote-spliced dangerous commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: 'cu""rl example.com' } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":false');
  });

  // Three arguments besides `command` reach bash, and the guard read only the
  // first. Each of these got past the entire denylist without any obfuscation:
  // the path, the variable, and the script were simply put in a field nothing
  // looked at.
  describe("the arguments besides `command`", () => {
    test("a path moved into working_directory does not escape a path rule", () => {
      const r = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command: "cat environ", working_directory: "/proc/1" } }),
        encoding: "utf8",
      });
      expect(r.stdout).toContain('"allow":false');
      expect(r.stdout).toContain("working_directory");
    });

    test("a working directory inside the repository is fine", () => {
      const r = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command: "ls", working_directory: "src/domain" } }),
        encoding: "utf8",
      });
      expect(r.stdout).toContain('"allow":true');
    });

    // The schema supplies the variable expansion the header calls out of reach
    // for a static check -- so resolve it, which makes the text more legible to
    // the rules rather than less.
    test("declared variables are substituted before matching", () => {
      const r = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({
          arguments: { command: "$TOOL example.com", environment_variables: { TOOL: "curl" } },
        }),
        encoding: "utf8",
      });
      expect(r.stdout).toContain('"allow":false');
    });

    test("refuses to let a declared variable decide what runs", () => {
      for (const name of ["PATH", "LD_PRELOAD", "BASH_ENV", "path"]) {
        const r = spawnSync("bun", ["run", SCRIPT], {
          input: JSON.stringify({ arguments: { command: "ls", environment_variables: { [name]: "/tmp/evil" } } }),
          encoding: "utf8",
        });
        expect(r.stdout, name).toContain('"allow":false');
      }
    });

    test("an ordinary declared variable is still allowed", () => {
      const r = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command: "echo $GREETING", environment_variables: { GREETING: "hi" } } }),
        encoding: "utf8",
      });
      expect(r.stdout).toContain('"allow":true');
    });

    // `bash -c` was blocked; bare `bash` reading the same script from stdin was
    // not, which is the same thing by another route.
    test("a bare interpreter fed on stdin is treated as -c", () => {
      for (const command of ["bash", "sh", "python3", "node", "/usr/bin/bash"]) {
        const r = spawnSync("bun", ["run", SCRIPT], {
          input: JSON.stringify({ arguments: { command, input_data: "echo hello" } }),
          encoding: "utf8",
        });
        expect(r.stdout, command).toContain('"allow":false');
      }
    });

    test("stdin text is matched for a command that is not an interpreter", () => {
      const r = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command: "tee script.sh", input_data: "curl example.com" } }),
        encoding: "utf8",
      });
      expect(r.stdout).toContain('"allow":false');
    });

    test("stdin text on an ordinary command is allowed", () => {
      const r = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command: "grep -c foo", input_data: "foo\nbar\n" } }),
        encoding: "utf8",
      });
      expect(r.stdout).toContain('"allow":true');
    });
  });
});
