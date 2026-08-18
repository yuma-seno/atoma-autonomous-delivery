/**
 * script-call.ts — Type-safe(r) invocation of the one-shot TS scripts in
 * `src/scripts/` (deployed flat into `.github/atoma/tools/scripts/*.ts` by
 * `build-dist.ts`) from inside a workflow step's `run:` bash.
 *
 * Every call site used to hardcode the *deployed* path as a bare string --
 * `bun run .github/atoma/tools/scripts/foo.ts` -- with zero connection to
 * the actual script file, PLUS a separately hand-typed import specifier
 * paired next to it purely so a rename/delete would fail `tsc --noEmit`.
 * Two independent strings, nothing stopping them from silently mismatching.
 *
 * Now every call site imports the script's own `ref` (see
 * `../../scripts/lib/script-ref.ts`) -- a real value, derived from the
 * script's `import.meta.url`, so there is only ONE thing identifying the
 * script (the import itself) and the deployed path is never hand-typed at
 * all. `scriptCommand()`/`scriptCommandWithArgs()` just turn that `ref` (and,
 * for the latter, a typed `args` object checked directly against the
 * script's own `Args` interface) into the `bun run ...` command string.
 */
import { toArgv } from "../../scripts/lib/cli.ts";
import type { ScriptRef } from "../../scripts/lib/script-ref.ts";

/**
 * Build a `bun run <deployed-path> [argv...]` command for a script that
 * takes no CLI flags at all (env-driven, or none) -- or whose CLI shape
 * doesn't fit a flat named-args object (e.g. `get_config_value.ts`'s
 * positional `<path> [default]`, built with its own `buildArgv()`). Pass a
 * pre-built argv array for that second case.
 */
/**
 * Where a workflow's own scripts are read from, as shell that resolves at run
 * time.
 *
 * Unset means the checkout, which is what every workflow but one wants. The
 * runner sets it, because a pull request run checks out the pull request and its
 * scripts would then be the pull request's own -- letting it decide how the agent
 * reviewing it behaves. See `atoma-runner.wac.ts`.
 *
 * A shell default rather than a generation-time choice, so one generated file
 * serves both: the workflows that never set it are byte-identical to before.
 */
export const MACHINERY_ROOT = "${ATOMA_MACHINERY_ROOT:-.}";

export function scriptCommand(ref: ScriptRef<void>, argv: readonly string[] = []): string {
  const path = `"${MACHINERY_ROOT}/${ref.runtimePath}"`;
  return argv.length > 0 ? `bun run ${path} ${argv.join(" ")}` : `bun run ${path}`;
}

/**
 * Build a `bun run <deployed-path> --flag "value" ...` command for a script
 * whose CLI flags are a flat named-args object. `args` is checked directly
 * against the script's own exported `Args` interface via `ref`'s type
 * parameter -- no separate import of that interface needed at the call site.
 *
 * `TArgs extends object` (not `extends Record<string, ...>`) because plain
 * named-property interfaces (e.g. `export interface FooArgs { repo: string }`)
 * have no index signature and don't structurally satisfy a `Record<...>`
 * constraint -- same reasoning as `CustomAction`'s `TWith` in `base.ts`.
 */
export function scriptCommandWithArgs<TArgs extends object>(ref: ScriptRef<TArgs>, args: TArgs): string {
  return scriptCommand(
    { runtimePath: ref.runtimePath },
    toArgv(args as Record<string, string | number | boolean | undefined>),
  );
}

