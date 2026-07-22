/**
 * script-call.ts — Type-safe(r) invocation of the one-shot TS scripts in
 * `src/scripts/` (deployed flat into `.github/atoma/tools/scripts/*.ts` by
 * `build-dist.ts`) from inside a workflow step's `run:` bash.
 *
 * Every call site used to hardcode the *deployed* path as a bare string --
 * `bun run .github/atoma/tools/scripts/foo.ts` -- with zero connection to
 * the actual script file. A rename/typo there is a silent runtime failure
 * (`bun run` exits 127, discovered only when the workflow actually runs),
 * not a compile error, and there's no way to jump from the workflow file to
 * the script it invokes.
 *
 * `scriptCommand()` instead takes the *dev-time* relative import specifier
 * -- the exact same string you'd write in an `import` statement, e.g.
 * `"../scripts/foo.ts"` -- and derives the deployed path from its basename
 * (`build-dist.ts` always flat-copies `src/scripts/**`, minus `lib/` and
 * `*.test.ts`, preserving basenames -- that invariant is what makes this
 * correct). Pairing the specifier with a real `import`/`import type` of that
 * same path (which every call site should already have, to get the script's
 * typed `Args`/`Env` contract -- see `../../scripts/lib/cli.ts`) means a
 * renamed or deleted script fails `bun run typecheck` immediately, at the
 * same place, instead of only surfacing at workflow-run time.
 */
import { basename } from "node:path";

/** Where `build-dist.ts` places scripts inside a deployed `.github/`. */
const SCRIPTS_RUNTIME_ROOT = ".github/atoma/tools/scripts";

/**
 * Resolve a `src/scripts/**` relative import specifier (e.g.
 * `"../scripts/foo.ts"`, exactly as written in an `import` statement) to its
 * deployed runtime path (e.g. `.github/atoma/tools/scripts/foo.ts`).
 */
export function scriptRuntimePath(scriptImportSpecifier: string): string {
  return `${SCRIPTS_RUNTIME_ROOT}/${basename(scriptImportSpecifier)}`;
}

/**
 * Build a `bun run <deployed-path> [argv...]` command string for embedding
 * in a step's `run:` bash, either as the whole command or spliced into a
 * larger heredoc (e.g. `` `AGENT=$(${scriptCommand(...)} 2>/dev/null)` ``).
 */
export function scriptCommand(scriptImportSpecifier: string, argv: readonly string[] = []): string {
  const path = scriptRuntimePath(scriptImportSpecifier);
  return argv.length > 0 ? `bun run ${path} ${argv.join(" ")}` : `bun run ${path}`;
}
