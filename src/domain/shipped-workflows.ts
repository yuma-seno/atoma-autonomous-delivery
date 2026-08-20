/**
 * shipped-workflows.ts — the workflows this template ships, used when a project
 * names none of its own.
 *
 * Two constants and no behaviour, in `domain/` rather than in `lib/`, because
 * three unrelated callers need them and one of those callers must not reach into
 * `lib/`. `lib/dispatch-targets.ts` was their home: a module that runs `gh`,
 * reads config.json off the disk and dispatches workflow runs. Importing it to
 * learn a default file name pulled all of that in — `atoma-validate-pr.wac.ts`
 * does exactly that today at generation time, and `domain/deliverable-integrity.ts`
 * cannot, being pure by construction.
 *
 * The shipped ones are the default because they are the arrangement this template
 * is for: a pipeline expressed as commands in config.json, which an agent can
 * write and a workflow file is not. A project that has its own workflows says so
 * in `workflows.ci` / `workflows.cd` and neither of these is consulted.
 *
 * Guessing `ci.yml` instead — a name a repository may or may not use — would
 * dispatch a workflow that does not exist and leave every pull request waiting
 * for a check that never reports.
 */

/**
 * Put a required check on a pull request's head commit before merging.
 *
 * Imported rather than repeated: `validate_pull_request.ts` reads `workflows.ci`
 * through a workflow step, and that step's fallback used to be written out with a
 * comment saying it matched this value — which is the admission that nothing
 * checked. Rename the shipped check workflow and the tool side would dispatch the
 * new name while the validation side dispatched the old one, `gh workflow run`
 * would fail, and every agent pull request would lose its required check with no
 * agent scheduled after it.
 */
export const DEFAULT_CI_WORKFLOW = "atoma-check.yml";

/** Dispatched after a successful merge. No-ops with no merge targets. */
export const DEFAULT_CD_WORKFLOW = "atoma-deploy.yml";
