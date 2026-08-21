#!/usr/bin/env bun
/**
 * probe-secret-holder.ts — stands in for a credential-holding MCP server.
 *
 * Three ways a server can hold a credential, so a reader can be pointed at each:
 *
 *   env      the value is in this process's environment block -- how tools.yaml
 *            routes credentials today
 *   stdin    the value arrives on stdin and lives only in the heap
 *   stdin+nd the same, and the process makes itself non-dumpable first
 *   env+nd   the value stays in the environment AND the process makes itself
 *            non-dumpable -- the arrangement that needs no change to how atoma
 *            delivers credentials, and the one the design now rests on
 *
 * The last one is the unknown #464 now turns on. `PR_SET_DUMPABLE(0)` is what
 * makes `/proc/<pid>/environ` and `/proc/<pid>/mem` unreadable to the same user,
 * atoma calls it for itself, and it does NOT survive `execve` -- so a server has
 * to call it in its own process. Whether Bun can is the question: it needs
 * `prctl`, and Bun reaches libc through `bun:ffi`.
 *
 * Nothing about Atoma is tested here. Run as:
 *   echo "<secret>" | bun run probe-secret-holder.ts <env|stdin|stdin+nd> <pidfile>
 */
import { dlopen, FFIType } from "bun:ffi";

const PR_SET_DUMPABLE = 4;
const PR_GET_DUMPABLE = 3;

const [mode, pidFile] = Bun.argv.slice(2);

/** Whether the process could make itself unreadable, and what it reports afterwards. */
function harden(): { called: boolean; dumpable: number | string; error?: string } {
  try {
    const { symbols } = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n);
    return { called: true, dumpable: symbols.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n) };
  } catch (error) {
    return { called: false, dumpable: "unknown", error: (error as Error).message };
  }
}

let hardened: ReturnType<typeof harden> | undefined;
if (mode === "stdin+nd" || mode === "env+nd") hardened = harden();

// The value. In `env` mode it is already in the environment block, put there by
// the caller; otherwise it is read here and exists only on the heap.
let secret = "";
if (mode === "env" || mode === "env+nd") {
  secret = process.env.PROBE_SECRET ?? "";
} else {
  secret = (await new Response(Bun.stdin.stream()).text()).split("\n")[0] ?? "";
}

// Held in a live reference so it cannot be collected before the reader looks.
const keep = { secret };

await Bun.write(
  pidFile,
  JSON.stringify({
    pid: process.pid,
    mode,
    secret_length: keep.secret.length,
    ffi_called: hardened?.called ?? null,
    dumpable_after: hardened?.dumpable ?? null,
    ffi_error: hardened?.error ?? null,
  }),
);

// Long enough for the reader, short enough that a failed probe does not hold the job.
await Bun.sleep(120_000);
console.error(keep.secret.length);
