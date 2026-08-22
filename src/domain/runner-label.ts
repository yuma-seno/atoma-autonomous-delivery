/**
 * runner-label.ts — which machine a project's own commands run on.
 *
 * `runs-on: ubuntu-latest` was hardcoded in eleven files, and `config.json` could
 * not reach any of them. For a project that builds on macOS, or that needs a
 * self-hosted runner for a licensed toolchain or a GPU, `atoma-check` and
 * `atoma-deploy` were simply unusable -- and fixing them meant editing
 * `.github/workflows/**`, the one place `GITHUB_TOKEN` cannot write. So neither an
 * agent nor a workflow could do it, and a hand-edited fork is overwritten by the
 * next upgrade (#435). The same argument that put `checks.commands` in
 * `config.json` applies: a fact a project owns was living where the project cannot
 * reach it.
 *
 * ## Two jobs, not a matrix
 *
 * `runs-on` cannot read a file, so a small job reads `config.json` first and the
 * real job takes its output. Measured on a throwaway branch (#437): asking for
 * `ubuntu-22.04` through a job output landed on `Ubuntu 22.04.5 LTS`, while
 * `ubuntu-latest` is 24.04 -- so the value genuinely decides the machine.
 *
 * A matrix was measured too, and rejected for now. The check run's NAME changes
 * under one: `atoma-check` becomes `atoma-check (ubuntu-latest)`, so the context a
 * ruleset requires stops existing and every pull request waits forever on a check
 * that will never report. Avoiding that needs a third job to carry the required
 * name -- worth doing when somebody needs several runners at once, and not before.
 *
 * One runner with SEVERAL LABELS is a different thing and does work here: a
 * self-hosted runner is selected by a list, and that is the array form below.
 *
 * ## Not the agent's own runner
 *
 * `atoma-runner` stays on Linux and this does not apply to it. What isolates a tool
 * server is Linux-only, top to bottom: `useradd` for the user with no sudo,
 * `setfacl` for POSIX ACLs granting traversal without read, `prctl(PR_SET_DUMPABLE)`
 * through libc, and `/proc/<pid>/environ` being the thing that has to be closed.
 * macOS has none of it.
 *
 * Making that configurable would mean an agent's shell running with every one of
 * those protections silently absent. The answer is not a setting; it is that the
 * agent runs on Linux, and the machine a project's own commands need is a separate
 * question -- which is the one this answers.
 */

/** The default, and what every workflow used before this existed. */
export const DEFAULT_RUNNER = "ubuntu-latest";

/**
 * What `runs-on` should be given, from a configured value.
 *
 * A string is one label. An array is a set of labels a single runner must have all
 * of -- `["self-hosted", "linux", "gpu"]` -- which is how a self-hosted runner is
 * addressed. Both end up as one job on one machine.
 *
 * Returns the default for anything unusable rather than failing: a workflow that
 * cannot start reports nothing about why, and the shipped default is a machine that
 * exists. `problems` says what was wrong, for `validate_deliverable` to surface at
 * pull request time, where it can be read.
 */
export function resolveRunsOn(configured: unknown): { labels: string[]; problems: string[] } {
  if (configured === undefined || configured === null) return { labels: [DEFAULT_RUNNER], problems: [] };

  if (typeof configured === "string") {
    const label = configured.trim();
    if (!label) return { labels: [DEFAULT_RUNNER], problems: ["runs_on is empty; using " + DEFAULT_RUNNER] };
    return { labels: [label], problems: [] };
  }

  if (Array.isArray(configured)) {
    const labels = configured.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    const problems: string[] = [];
    if (labels.length !== configured.length) {
      problems.push("runs_on has entries that are not non-empty strings; those are ignored");
    }
    if (labels.length === 0) {
      return { labels: [DEFAULT_RUNNER], problems: [...problems, `runs_on names no usable label; using ${DEFAULT_RUNNER}`] };
    }
    return { labels, problems };
  }

  return { labels: [DEFAULT_RUNNER], problems: [`runs_on must be a string or a list of strings; using ${DEFAULT_RUNNER}`] };
}

/**
 * The value to write into `$GITHUB_OUTPUT` for a later job's `runs-on`.
 *
 * Always JSON, so the consumer is always `fromJSON(...)` and there is no branch
 * that behaves differently for one label than for three. A bare string would work
 * for the single case and silently select nothing for the array case, and the two
 * would be written in different places.
 */
export function runsOnOutput(labels: readonly string[]): string {
  return JSON.stringify(labels);
}
