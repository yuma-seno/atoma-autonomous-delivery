/**
 * The two invariants of the confined shell's identity, both of which have already
 * been violated once and neither of which shows up as an error at the time.
 *
 * A collision on the uid, and a subordinate range naming ids the container cannot
 * see, both surface as one line inside one tool call, hours later, in a run nobody
 * is watching. So they are pinned here instead.
 */
import { describe, expect, test } from "bun:test";
import {
  assertIdentityIsFree,
  CONTAINER_UID,
  CONTAINER_USER_NAME,
  ID_MAP_SHIM,
  IDS_IN_THIS_CONTAINER,
  SUBID_RANGES,
} from "./prepare_shell_confinement.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How many ids exist inside the container, measured from inside it:
 *
 *   $ cat /proc/self/uid_map
 *            0       1001          1
 *            1     165536      65536
 *
 * A user namespace maps only ids its parent already has, and this container is the
 * parent of every nested one.
 */
const IDS_THE_CONTAINER_HAS = 65536;

describe("the container's subordinate id ranges", () => {
  const ranges = () => SUBID_RANGES.map((range) => range.split(":").map(Number) as [number, number]);
  const total = () => ranges().reduce((sum, [, count]) => sum + count, 0);

  // Every one of these is a run of the probe that failed, and each failure named
  // something different, at a depth where the message alone did not say which.
  test("stays inside the ids this container has", () => {
    for (const [start, count] of ranges()) {
      expect(start, "outer 0 is the host runner user and stays undelegated").toBeGreaterThan(0);
      expect(
        start + count - 1,
        `this container's own map covers 1..${IDS_IN_THIS_CONTAINER}, so anything above names nothing`,
      ).toBeLessThanOrEqual(IDS_IN_THIS_CONTAINER);
    }
  });

  // "invalid configuration: the specified mapping 1:65535 in /etc/subuid includes
  // the user UID" -- podman refuses to start at all, so this is not a subtle one.
  test("hands out no range containing the id the container runs as", () => {
    for (const [start, count] of ranges()) {
      const contains = CONTAINER_UID >= start && CONTAINER_UID < start + count;
      expect(contains, `${start}:${count} includes CONTAINER_UID ${CONTAINER_UID}`).toBe(false);
    }
  });

  // The ids inside a nested container are numbered 1..total, so the total is what
  // decides which USER an image may declare. Too narrow and it cannot start:
  // "crun: setgroups: Invalid argument". distroless is 65532; `nobody` is 65534.
  test("is wide enough for the non-root users images actually declare", () => {
    expect(total(), "an image declaring nobody (65534) could not start").toBeGreaterThanOrEqual(65534);
  });

  test("leaves no id between the ranges unaccounted for", () => {
    // Two entries exist only to step over CONTAINER_UID. If they ever drift apart
    // further than that, ids vanish from the middle for no stated reason.
    const sorted = ranges().sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      const previousEnd = (sorted[i - 1] as [number, number])[0] + (sorted[i - 1] as [number, number])[1];
      const gap = (sorted[i] as [number, number])[0] - previousEnd;
      expect(gap, "the only gap should be CONTAINER_UID itself").toBe(1);
    }
  });
});

describe("the identity check", () => {
  const hostPasswd = "root:x:0:0::/root:/bin/bash\nrunner:x:1001:1001::/home/runner:/bin/bash\n";

  test("passes when the host uses neither the name nor the id", () => {
    expect(() => assertIdentityIsFree(hostPasswd)).not.toThrow();
  });

  // This is the one that happened: the runner image has `packer` at 1000, the
  // generated passwd is the host's plus one line, and the earlier entry wins.
  test("refuses an id the host already uses", () => {
    const withCollision = `${hostPasswd}packer:x:${CONTAINER_UID}:${CONTAINER_UID}::/home/packer:/bin/bash\n`;
    expect(() => assertIdentityIsFree(withCollision)).toThrow(/already uses uid/);
  });

  test("refuses a name the host already uses", () => {
    const name = CONTAINER_USER_NAME;
    const withCollision = `${hostPasswd}${name}:x:4242:4242::/home/${name}:/bin/bash\n`;
    expect(() => assertIdentityIsFree(withCollision)).toThrow(/already has an account named/);
  });
});

/**
 * The shim stands in for newuidmap, so what podman hands it has to come back out as
 * the map file's own format: one line of "inside outside count" per triple, all of
 * it in a single write.
 *
 * The real invocation, from #426:
 *
 *   newuidmap 44 0 1234 1 1 10000 50000
 *
 * and the two lines that run then wrote by hand, successfully. Getting this wrong
 * fails inside a container, at a depth where the error says only EPERM.
 *
 * Runs the generated script for real rather than reading it, with only the
 * destination substituted -- /proc/<pid>/uid_map cannot be faked and is one line of
 * redirection anyway.
 */
describe("the id-mapping shim", () => {
  const linux = process.platform === "linux";
  const runShim = (name: string, args: string[]): { out: string; code: number } => {
    const dir = mkdtempSync(join(tmpdir(), "shim-"));
    const target = join(dir, "map");
    const script = join(dir, name);
    writeFileSync(script, ID_MAP_SHIM.replace('> "/proc/$pid/$map"', '> "$ATOMA_TEST_MAP"'));
    const result = Bun.spawnSync({
      cmd: ["sh", script, ...args],
      env: { ...process.env, ATOMA_TEST_MAP: target },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    try {
      out = readFileSync(target, "utf8");
    } catch {
      out = "";
    }
    return { out, code: result.exitCode ?? -1 };
  };

  test.skipIf(!linux)("turns podman's argv into the map file's own format", () => {
    const { out, code } = runShim("newuidmap", ["44", "0", "1234", "1", "1", "10000", "50000"]);
    expect(code).toBe(0);
    expect(out).toBe("0 1234 1\n1 10000 50000\n");
  });

  test.skipIf(!linux)("refuses a call with no mapping rather than writing nothing", () => {
    const { code } = runShim("newuidmap", ["44"]);
    expect(code).not.toBe(0);
  });

  // One file under both names, so which map it writes can only come from argv[0].
  test("chooses the map file from the name it was invoked as", () => {
    expect(ID_MAP_SHIM).toContain("*gidmap) map=gid_map");
    expect(ID_MAP_SHIM).toContain("map=uid_map");
  });

  // The setuid bit is what broke the two versions before this one: it clears the
  // ambient set the container's capabilities live in.
  test("is not installed setuid anywhere", () => {
    const workflow = readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8");
    const install = workflow.split("\n").filter((line) => line.includes("newidmap"));
    expect(install.length).toBeGreaterThan(0);
    for (const line of install) {
      expect(line, "a setuid mode would throw away the ambient capabilities").not.toMatch(/[24]7?55|u\+s/);
    }
  });
});
