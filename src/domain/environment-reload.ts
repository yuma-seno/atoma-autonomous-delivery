/**
 * environment-reload.ts — how many times one piece of work may rebuild its
 * environment, and what the agent is told when it may not.
 *
 * ## What reloading is for
 *
 * `environment.setup_commands` runs as a workflow step, as `runner`, which has
 * passwordless sudo. The agent runs as `atoma-tools`, which does not. So there is a
 * set of things an agent cannot do to its own environment at all:
 *
 *   - install a system package (`apt-get`)
 *   - install a global CLI (`/usr/local/lib` is not writable, and the runner
 *     closes the world-writable directories on PATH)
 *
 * And one it can do but should not have to: rebuilding a work tree it broke.
 *
 * Reloading re-runs the setup as a workflow step and dispatches the agent again.
 * The property that makes it safe is the split: **the commands come from the
 * default branch, the data from the work tree.** An agent can add a dependency to
 * `package.json` and get a trusted install command run against it, without being
 * able to edit the install command. Editing `setup.sh` would be arbitrary code
 * execution as a user with sudo; this is not that.
 *
 * ## What it does NOT do, and why the message has to say so
 *
 * It cannot install a system package the default branch does not already ask for.
 * The commands come from there, so a package the agent decided it needs is not in
 * them yet -- that change goes through `setup_commands`, which is a governed path
 * and needs a person. An agent that reloads hoping to get `libfoo-dev` gets the
 * same environment back and has spent a run finding out.
 *
 * ## Why there is a limit at all
 *
 * A reload starts a NEW RUN, and a run's own limits reset with it. Without a limit,
 * reloading is an unbounded extension of whatever bounds a run -- which is
 * why #456 blocked this: the budget that bounds a run cannot be bounded by
 * something the run can reset at will.
 *
 * Counted differently from the handoff limit in `dispatch-chain.ts`, and the
 * difference is not arbitrary. That one is derived from comments, because handoffs
 * leave comments. A reload leaves none, so there is nothing to count -- the tally
 * travels as a workflow input instead, which is what #456's own proposal suggested.
 */

/**
 * How many times one piece of work may rebuild its environment.
 *
 * Three, matching `CI_RETRY_LIMIT` and for the same reason: enough for a fix that
 * needed another look, few enough that a genuinely stuck run reaches a person
 * quickly. There is no measured history to pick a better number from -- the tool
 * does not exist yet -- so it borrows the one limit here that has worked.
 */
export const DEFAULT_RELOAD_LIMIT = 3;

/**
 * A limit from configuration, or the default.
 *
 * Zero and nonsense mean the default, the rule every limit in this project shares
 * (see `dispatch-chain.ts` and `infra::timeouts` in atoma). A project that wants
 * no reloads at all is asking for a different thing -- that the tool not be
 * offered -- and would say so by removing `atoma_env` from the agent's `mcp_servers`.
 */
export function resolveReloadLimit(configured: unknown): number {
  const value = typeof configured === "number" ? configured : Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RELOAD_LIMIT;
}

/** How many reloads this run is already the result of. Absent or unusable means none. */
export function reloadsSoFar(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Why this reload is refused, or `undefined` when it may go ahead.
 *
 * A message rather than a boolean, and a message the agent can act on. The tool
 * returns it as a tool error instead of ending the run, so the agent keeps its turn
 * and can switch to reporting -- which is the useful thing left to do. A run that
 * simply died here would take the reason with it.
 */
export function reloadRefusal(soFar: number, limit: number): string | undefined {
  if (soFar < limit) return undefined;
  return (
    `This run has already rebuilt its environment ${soFar} time${soFar === 1 ? "" : "s"}, which is the limit ` +
    `(${limit}). Reloading again is refused: each one starts a new run with a fresh time budget, so an ` +
    `unbounded chain of them is an unbounded chain of runs. ` +
    `Report what you found instead -- say which dependency or tool is missing and what you were trying to do -- ` +
    `and a person can decide. If the answer is a system package, it belongs in ` +
    `\`environment.setup_commands\` in .github/atoma/config.json, which needs a human merge either way.`
  );
}

/**
 * What the agent is told after a reload is accepted.
 *
 * Names the count, because a limit the agent cannot see is one it cannot plan
 * against: knowing this is the third of three changes what a reasonable next step
 * is. The tally is not otherwise visible to it -- reloads leave no comments.
 */
export function reloadAccepted(next: number, limit: number): string {
  return (
    `Rebuilding the environment and starting a new run (${next} of ${limit}). ` +
    `The setup commands come from the default branch and run against the current work tree, so a dependency ` +
    `you added to a manifest will be installed. A system package the default branch does not already install ` +
    `will NOT appear -- that needs \`environment.setup_commands\` and a person. This session ends now.`
  );
}
