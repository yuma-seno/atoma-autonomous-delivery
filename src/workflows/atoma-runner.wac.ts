import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import type { GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedOutputsStep, type DefinedJob } from "./actions/base.ts";
import {
  ATOMA_DEFAULT_VERSION,
  ATOMA_VERSION_DESC,
  checkoutAtomaSourceStep,
  installAtomaCliStep,
} from "./actions/atoma-cli.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { defineCallableWorkflow } from "./actions/reusable-workflow.ts";
import { scriptCommand, scriptCommandWithArgs } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { CacheAction } from "./actions/cache.ts";
import { environmentSetupStep } from "./actions/environment-setup.ts";
import { ref as resolveNotifyRef } from "../scripts/resolve_notify.ts";
import { buildArgv as configValueArgv, ref as getConfigValueRef } from "../scripts/get_config_value.ts";
import { ref as resolveIssueBranchRef } from "../scripts/resolve_issue_branch.ts";
import { ref as manageInProgressLabelRef } from "../scripts/manage_in_progress_label.ts";
import { ref as notifyMaxIterationsRef } from "../scripts/notify_max_iterations.ts";
import { ref as injectUncommittedNoticeRef } from "../scripts/inject_uncommitted_notice.ts";
import { ref as restoreWorkspaceRef } from "../scripts/restore_workspace.ts";
import { ref as saveWorkspaceRef } from "../scripts/save_workspace.ts";
import { WORKSPACE_PATH } from "../domain/workspace.ts";
import { ref as fetchEventsRef } from "../scripts/fetch_events.ts";
import { ref as restoreAgentSessionRef } from "../scripts/restore_agent_session.ts";
import { ref as reconcileGithubSessionRef } from "../scripts/reconcile_github_session.ts";
import { ref as extractDirectiveRef } from "../scripts/extract_directive.ts";
import { ref as postResultCommentRef } from "../scripts/post_result_comment.ts";
import { ref as recordRunMetadataRef } from "../scripts/record_run_metadata.ts";
import { ref as saveAgentSessionRef } from "../scripts/save_agent_session.ts";
import { ref as manageDispatchLoopRef } from "../scripts/manage_dispatch_loop.ts";
import { ref as decideGuardReleaseRef } from "../scripts/decide_guard_release.ts";
import { runCredentialEnv, secretNamesStep, secretSlotEnv } from "./actions/secret-slots.ts";
import { ref as redactStreamRef } from "../scripts/redact_stream.ts";
import { ref as writeCredentialsFileRef } from "../scripts/write_credentials_file.ts";
import { AGENT_NAME_PATTERN } from "../lib/agent-name.ts";
import { LLM_CONTEXT_TAG } from "../lib/tags.ts";

// The shared reusable workflow every entry-point workflow (atoma-entry,
// atoma-auto-trigger, atoma-manual-comment, atoma-pr-review) hands off to via
// `atomaRunnerWorkflow.call(...)` (see actions/reusable-workflow.ts) once
// they've resolved an `agent`/`number`/`type`. Single job ("run"), step
// sequence below mirrors execution order top to bottom:
//
//   1. checkout repo + resolve/create the working branch
//   2. install runtime deps (atoma CLI, Bun, MCP server deps)
//   3. run configured environment setup, set git identity
//   4. resolve `notify` login + this agent's `max_iterations` from config
//   5. add atoma/in-progress label, resolve which repository secrets config.json
//      lets the agent see, then RUN THE AGENT
//   6. post the agent's result as a comment
//   7. handle follow-ups: uncommitted-changes notice, max-iterations notice,
//      loop control, THEN remove the label (only if this run reached a
//      genuine stopping point -- see removeLabelStep/REMOVE_LABEL_GUARD --
//      otherwise it stays on while a sub-agent/PR/next-agent handoff is
//      still in flight), dispatch the next agent in the chain (if any)

const AGENT_INPUT_DESC = "Agent name to invoke";
const NUMBER_INPUT_DESC = "Issue or PR number";
const NOTIFY_INPUT_DESC = "GitHub login to mention on completion";
const SESSION_MODE_INPUT_DESC = "Session mode: continue restores history; recover archives history and rebuilds from GitHub context";
// The version this installs, the description of the input that overrides it, and the
// two steps that install it live in `actions/atoma-cli.ts` -- along with the record of
// what each raise of the pin was coupled to, which is the part worth not losing.
//
// They were here until `atoma-validate-pr` needed the same binary, to run
// `atoma validate` against the agent definitions and tools file a pull request would
// merge. Two workflows installing it from two copies of a download-and-chmod is two
// places to move the pin, and the pin is coupled to `tools/tools.yaml`, to
// `agent-definitions/*.md` and to the repository's secrets.

// Deployed-repo-relative paths into the `.github/atoma/` content tree (see
// src/atoma/ -- config.json, agent-definitions/, tools/tools.yaml).
// Referenced from three separate steps below (prepare/run/dispatch-next);
// centralized here so they can't drift from each other by typo.
/**
 * Where the default branch is checked out, alongside the workspace.
 *
 * A pull request run checks out the pull request, and every script and setting
 * this job reads used to come from there -- so a pull request could decide how
 * the agent reviewing it behaves: which agent, which iteration budget, which
 * commands, which credentials. #337 closed that for the credential declaration
 * alone; this closes it for the rest.
 *
 * The split is between the work and the machinery. The workspace stays the pull
 * request, because that is what is under review and what the agent writes to;
 * the scripts, configuration, agent definitions, prompt and tools file come from
 * here.
 *
 * A change to the machinery is therefore not exercised by its own review. That
 * is the intent rather than a loss: `.github/**` is governed, so a person reads
 * that diff, and CI still runs the pull request's own checks.
 */
const MACHINERY_DIR = "atoma-machinery";

/**
 * Where the machinery ends up, once it is out of the work tree.
 *
 * `actions/checkout` can only write under `GITHUB_WORKSPACE` -- that is its rule,
 * not a choice here -- so the checkout lands in the work tree and is moved out
 * immediately afterwards.
 *
 * It has to leave, because while it was there `git status` was never clean:
 *
 *     ?? atoma-machinery/
 *
 * Which meant `git add -A` committing it as a dangling gitlink with no
 * `.gitmodules`, and `create_pr` refusing for a dirty worktree. `.gitignore` in
 * this repository already carries `atoma-src/` with a comment describing exactly
 * that failure -- the same shape, found once, and `atoma-machinery/` was never
 * added beside it. An adopter has neither, so it happened to all of them.
 *
 * The alternative was `.git/info/exclude`, which needs nothing from an adopter and
 * is two lines. It was rejected: the directory would still be visible to `ls`, so
 * the invariant #461 exists to state --
 *
 *     Everything in the work tree is a deliverable.
 *
 * -- would need "except that one" appended, which is the sentence this was all
 * meant to avoid.
 */
const MACHINERY_ABS = "\${RUNNER_TEMP}/atoma-machinery";

/** The same directory, as shell -- the job exports it so every step agrees. */
const MACHINERY = "${ATOMA_MACHINERY_ROOT}";

const ORCHESTRATION_FILE = ".github/atoma/config.json";
const AGENT_DEF_DIR = ".github/atoma/agent-definitions";
const PROMPT_TEMPLATE = ".github/atoma/prompt-template.md";
const SKILLS_DIR = ".github/atoma/skills";
const TOOLS_FILE = ".github/atoma/tools/tools.yaml";

/**
 * The OS user every tool server runs as.
 *
 * One user for all of them, so no tool's environment differs from another's --
 * which is the property the container it replaced could not give. And not in
 * sudoers, because with sudo nothing else means anything: `sudo cat
 * /proc/<pid>/environ` reads any process, whatever else is arranged.
 *
 * See `tools/tools.yaml`'s `shell` entry for what that leaves protected and what
 * it leaves exposed. The short version: the provider API key is never in a tool
 * server, the servers this project ships protect their own credentials, and a
 * credential routed to a third-party server is readable by the shell.
 */
const TOOL_USER = "atoma-tools";

/**
 * Where that user's caches go.
 *
 * `$HOME` is the runner's, readable and NOT writable, the same for every tool -- so
 * a write there fails rather than appearing to work and vanishing, which is the
 * failure the container produced. Package managers need somewhere real, and this
 * is it: outside the work tree, so nothing commits it.
 */
const TOOL_CACHE = "\${RUNNER_TEMP}/atoma-tool-cache";

/**
 * Where this run's own files go: the session, the fetched events, the ops log, and
 * the agent's stdout and stderr.
 *
 * Outside the work tree, and that is the whole point. All five used to be written
 * to the repository root, which had two costs:
 *
 *   - the engineer's `git add -A` committed them, so an adopter had to add five
 *     lines to `.gitignore` before anything worked. Skip it and `create_pr` --
 *     which requires a clean worktree -- refused every time, with nothing naming
 *     the cause.
 *   - "everything in the work tree is a deliverable" was not true, so it could not
 *     be told to an agent as one sentence.
 *
 * `RUNNER_TEMP` because a job does not keep it, which is right: none of these
 * outlives the run. The session is persisted to the `atoma-data` branch instead,
 * and that is a deliberate save rather than a side effect of where a file happened
 * to sit.
 *
 * Created early (before anything writes into it) and handed to the tool user later
 * (once that user exists). Both halves are load-bearing: three steps write here
 * before the user is created, and `atoma run` writes the session as that user.
 */
const RUN_DIR = "\${RUNNER_TEMP}/atoma-run";

/**
 * The agent's scratch workspace: restored before the run, saved after it.
 *
 * A literal path rather than `RUNNER_TEMP`, and `domain/workspace.ts` explains why
 * -- briefly, the agent is told this path in one sentence and a path it has to
 * expand is a path it can get wrong in a way that looks like an empty directory.
 *
 * Owned by the tool user with an ACL back to the runner, the same arrangement as
 * `RUN_DIR`: the runner unpacks into it before the agent starts and packs it up
 * afterwards, while everything the agent does in it happens as the tool user.
 */
const WORKSPACE_DIR = WORKSPACE_PATH;

const restoreWorkspaceStep = new TypedOutputsStep(
  {
    name: "Restore the agent's workspace",
    id: "workspace",
    shell: "bash",
    env: { GH_TOKEN: "${{ github.token }}" },
    run: `${scriptCommandWithArgs(restoreWorkspaceRef, {
      type: "${{ inputs.type }}",
      number: "${{ inputs.number }}",
      dest: WORKSPACE_DIR,
      repo: "${{ github.repository }}",
    })}\n`,
  },
  ["root_issue", "restored"] as const,
);

const resolveIssueBranchStep = new TypedOutputsStep(
  {
    name: "Resolve the issue's branch",
    id: "issue-branch",
    if: "inputs.type == 'issue'",
    shell: "bash",
    env: { GH_TOKEN: "${{ github.token }}" },
    run: `${scriptCommandWithArgs(resolveIssueBranchRef, {
      repo: "${{ github.repository }}",
      issue: "${{ inputs.number }}",
    })}\n`,
  },
  ["branch"] as const,
);
// Hook scripts named by `tools.yaml`. Atoma resolves a relative hook path
// against the directory holding that file, so these two have to agree.
const TOOL_HOOKS_DIR = ".github/atoma/tools/scripts/hooks";

// Every input this workflow takes is spliced into shell TEXT somewhere below:
// `AGENT="${{ inputs.agent }}"`, `BRANCH="atoma/issue-${{ inputs.number }}"`,
// `VERSION="${{ inputs.atoma_version }}"`, and a dozen `--flag "${{ ... }}"`
// script arguments. GitHub Actions substitutes `${{ }}` into the script before
// bash ever parses it, so a value carrying a quote or a `$(...)` is not data --
// it is code, running in a job that holds write scopes and, via
// `secrets: inherit`, the provider API keys.
//
// The step below is the boundary. It runs first, reads every input through
// `env:` (where a value can only ever be data), and refuses anything outside a
// narrow shape. One check covering all sinks, rather than converting each of a
// dozen interpolations and hoping the next one added remembers -- which is the
// same reasoning as the `directive` guard in dispatchNextAgentStep, applied to
// the inputs instead of the outputs.
//
// The agent pattern is GENERATED from lib/agent-name.ts rather than written out
// here, so this bash test and the TypeScript `isAgentName()` that validates the
// same value at its producers cannot drift apart.
const validateInputsStep = new TypedOutputsStep({
  name: "Validate workflow inputs",
  shell: "bash",
  env: {
    AGENT: "${{ inputs.agent }}",
    NUMBER: "${{ inputs.number }}",
    TYPE: "${{ inputs.type }}",
    SESSION_MODE: "${{ inputs.session_mode }}",
    ATOMA_VERSION: "${{ inputs.atoma_version }}",
    NOTIFY: "${{ inputs.notify }}",
  },
  run: `reject() {
  echo "::error::atoma-runner received an invalid \\\`$1\\\` input: '$2'. $3"
  exit 1
}

[[ "$AGENT" =~ ^${AGENT_NAME_PATTERN}$ ]] ||
  reject agent "$AGENT" "Expected a bare lowercase agent name, e.g. 'engineer'."
[[ "$NUMBER" =~ ^[0-9]+$ ]] ||
  reject number "$NUMBER" "Expected an issue or pull request number."
[[ "$TYPE" == "issue" || "$TYPE" == "pr" ]] ||
  reject type "$TYPE" "Expected 'issue' or 'pr'."
[[ "$SESSION_MODE" == "continue" || "$SESSION_MODE" == "recover" ]] ||
  reject session_mode "$SESSION_MODE" "Expected 'continue' or 'recover'."
# 'source' builds from a checkout; anything else is fetched as a release asset
# and interpolated into a download URL, so keep it to a tag-shaped string.
[[ "$ATOMA_VERSION" =~ ^(source|latest|v[0-9A-Za-z._-]+)$ ]] ||
  reject atoma_version "$ATOMA_VERSION" "Expected 'source', 'latest', or a release tag like 'v0.1.7'."
# May be empty: a run with nobody to notify is normal.
[[ "$NOTIFY" =~ ^[A-Za-z0-9-]*$ ]] ||
  reject notify "$NOTIFY" "Expected a GitHub login, or empty."

echo "Inputs validated: \${TYPE} #\${NUMBER}, agent=\${AGENT}, session_mode=\${SESSION_MODE}"
`,
});

// Referenced downstream by name only where a later step (or the job's own
// `if`/`outputs`) needs to read a `.outputs`/`.rawOutputs` value; every step
// with no such reference is inlined directly into the `.addSteps([...])`
// array below in its actual execution position instead -- so that array is
// the single, complete, top-to-bottom picture of what this job does, not
// just a name-list requiring you to hunt down each step's own declaration.

const notifyStep = new TypedOutputsStep(
  {
    // Defense in depth: inputs.notify *should* already carry the human to
    // ping (see resolve_notify.ts / atoma:notify= tag propagation), but if
    // it ever arrives empty (a missed dispatch path, a new caller that
    // forgot to wire it, etc.) we do a live fallback lookup here so a run
    // that ends with neither a next-agent directive nor a notify never goes
    // completely silent. Cheap no-op when notify is already set.
    name: "Resolve effective notify login",
    id: "notify",
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      NOTIFY: "${{ inputs.notify }}",
      NUMBER: "${{ inputs.number }}",
    },
    run: `EFFECTIVE="$NOTIFY"
if [ -z "$EFFECTIVE" ]; then
  EFFECTIVE=$(${scriptCommandWithArgs(resolveNotifyRef, { repo: "\${GITHUB_REPOSITORY}", number: "\${NUMBER}" })})
  [ -n "$EFFECTIVE" ] && echo "Resolved notify fallback: \${EFFECTIVE}"
fi
echo "notify=\${EFFECTIVE}" >> "$GITHUB_OUTPUT"
`,
  },
  ["notify"] as const,
);

const fetchEventsStep = new TypedOutputsStep(
  {
    name: "Fetch GitHub events",
    id: "fetch",
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      GITHUB_REPOSITORY: "${{ github.repository }}",
    },
    run: `${scriptCommandWithArgs(fetchEventsRef, {
      type: "${{ inputs.type }}",
      number: "${{ inputs.number }}",
      out: `${RUN_DIR}/events.json`,
    })}\n`,
  },
  ["resolved_type", "resolved_number"] as const,
);

const restoreSessionStep = new TypedOutputsStep({
  name: "Restore agent session from atoma-data",
  id: "restore-session",
  shell: "bash",
  run: `${scriptCommandWithArgs(restoreAgentSessionRef, {
    type: fetchEventsStep.outputs.resolved_type,
    number: fetchEventsStep.outputs.resolved_number,
    agent: "${{ inputs.agent }}",
    out: `${RUN_DIR}/session.json`,
    "session-mode": "${{ inputs.session_mode }}",
  })}\n`,
});

const buildContextStep = new TypedOutputsStep(
  {
    name: "Merge GitHub context into session",
    id: "context",
    shell: "bash",
    // A token, because this step now fetches the images an issue references —
    // an attachment on a private repository is not public.
    env: { GH_TOKEN: "${{ github.token }}" },
    run: `${scriptCommandWithArgs(reconcileGithubSessionRef, {
      events: `${RUN_DIR}/events.json`,
      "agent-name": "${{ inputs.agent }}",
      // Read for its `vision` field: an agent whose model cannot see a picture
      // must not be sent one.
      "agent-def": `${MACHINERY}/${AGENT_DEF_DIR}/\${{ inputs.agent }}.md`,
      config: `${MACHINERY}/${ORCHESTRATION_FILE}`,
      session: `${RUN_DIR}/session.json`,
      out: `${RUN_DIR}/session.json`,
    })}\n`,
  },
  ["new_event_count", "context_snapshot_hash", "context_event_count"] as const,
);

const cfgStep = new TypedOutputsStep(
  {
    name: "Read max_iterations from config",
    id: "cfg",
    shell: "bash",
    env: { AGENT_NAME: "${{ inputs.agent }}" },
    run: `MAX=$(${scriptCommand(getConfigValueRef, configValueArgv("agents.${AGENT_NAME}.max_iterations", "30"))})
echo "max_iterations=\${MAX}" >> "$GITHUB_OUTPUT"
echo "Agent \${AGENT_NAME} max_iterations: \${MAX}"
`,
  },
  ["max_iterations"] as const,
);

/**
 * Which repository secrets config.json lets this run hand to the agent.
 *
 * A step and not a job: step-level `env:` is evaluated when the step runs, so
 * the "Run agent" step below can use this output as the KEY of a secret lookup.
 * A job would have added a second runner to every agent run to learn the same
 * thing. `tools` is the destination — a credential declared for checks or for a
 * deployment reaches those workflows and never this one.
 */
const toolSecretsStep = secretNamesStep("tools");

const installAtomaCli = installAtomaCliStep("${{ inputs.atoma_version }}");

/**
 * Outside the workspace, so the checkout cannot have placed it and nothing commits
 * it — and inside a directory the TOOL USER owns, so atoma can delete it.
 *
 * That second half is load-bearing and was nearly missed. atoma reads this file
 * and unlinks it before starting any server, which is what keeps the file and the
 * servers from ever coexisting. Unlinking needs write permission on the containing
 * DIRECTORY, not on the file — so a file owned by the tool user inside a directory
 * owned by the runner cannot be deleted by it, and the core's delete is
 * best-effort: it logs "it stays readable to anything running as this user for the
 * rest of the run" and carries on. Every credential the run supplies would sit
 * there, readable by the shell server, for the whole run.
 */
const CREDENTIALS_DIR = "$RUNNER_TEMP/atoma-credentials";
const CREDENTIALS_FILE = `${CREDENTIALS_DIR}/credentials.json`;

/**
 * The one step that holds this run's credentials, and it exits before the agent
 * starts.
 *
 * Everything a run needs goes into a file here rather than into the agent step's
 * `env:`. That step's bash lives for the whole of `atoma run`, and
 * `/proc/<pid>/environ` keeps what was on the stack at exec for a process's
 * lifetime -- so credentials placed there are readable by every tool server the
 * agent starts, for minutes, and `unsetenv` cannot take them back.
 *
 * atoma reads the file and deletes it before starting any server, so the file and
 * the servers never coexist; from then on the values are only in atoma's heap,
 * which is out of reach because it makes itself non-dumpable.
 */
const writeCredentialsStep = new TypedOutputsStep({
  name: "Collect this run's credentials into a file",
  shell: "bash",
  env: {
    // Every credential the run supplies, from the list that decides what that means.
    // These were written out here as well, six lines against six entries, currently in
    // sync and with nothing keeping them so: a seventh added to `RUN_CREDENTIALS` would
    // be looked up by `collect()`, never supplied here, dropped for being empty, and the
    // run would fail at the first inference with a provider error naming nothing near the
    // omission. `secretSlotEnv()` below was already generated, which made the
    // hand-written half look deliberate.
    //
    // `GH_TOKEN` is the exception and stays written: its value is the run's own token
    // rather than a repository secret.
    ...runCredentialEnv(),
    // Written here rather than generated: its value is the run's own token, not a
    // repository secret, so it is not one of the names `RUN_CREDENTIALS` can supply.
    GH_TOKEN: "${{ github.token }}",
    // Plus whatever config.json declared. See `actions/secret-slots.ts`.
    ...secretSlotEnv(),
  },
  run: `${scriptCommandWithArgs(writeCredentialsFileRef, { out: CREDENTIALS_FILE })}
# Handed to the user atoma runs as, which reads it and deletes it before starting
# any server. Handed over rather than opened up: it holds every credential the run
# supplies, and this step's own user keeps none of them afterwards.
sudo chown ${TOOL_USER} "${CREDENTIALS_FILE}"
`,
});

const runAgentStep = new TypedOutputsStep(
  {
    name: "Run agent",
    id: "atoma",
    if: `${buildContextStep.rawOutputs.new_event_count} != '0'`,
    // No credentials here, and that is the point of the step above.
    //
    // This step's bash lives for the whole of `atoma run`, so anything in its
    // `env:` sits in `/proc/<pid>/environ` for minutes, readable by every tool
    // server the agent starts. `unsetenv` cannot take it back -- that file
    // reflects what was on the stack at exec. So the values are written to a file
    // by the previous step, whose bash exits before the agent begins, and atoma
    // deletes that file before starting any server.
    //
    // `GITHUB_PERSONAL_ACCESS_TOKEN` is gone rather than moved: nothing in either
    // repository reads it. It was a token in an environment for no consumer.
    env: {
      GITHUB_RUN_ID: "${{ github.run_id }}",
      ISSUE_NUMBER: fetchEventsStep.outputs.resolved_number,
      // Whether ISSUE_NUMBER is an issue or a pull request. `commit_and_push`
      // creates a branch on an issue run and never on a pull request run, where
      // the checkout is already the branch under review.
      ATOMA_RUN_TYPE: "${{ inputs.type }}",
      ISSUE_NOTIFY: notifyStep.outputs.notify,
      // Structured JSON-lines log every MCP tool mutation/dispatch decision
      // is written to (see lib/ops-log.ts) -- read back below to determine
      // chain_continues, and generally useful as a per-run audit trail.
      ATOMA_OPS_LOG: `${RUN_DIR}/atoma_ops.log`,
      // Repository variables, not secrets: which provider to use and which host
      // to reach. The `_IN` suffix keeps them out of the names Atoma reads until
      // the script has checked they are non-empty, so an unset variable cannot
      // defeat provider auto-detection by arriving as an empty string.
      OPENAI_BASE_URL_IN: "${{ vars.OPENAI_BASE_URL }}",
      ATOMA_PROVIDER_IN: "${{ vars.ATOMA_PROVIDER }}",
    },
    shell: "bash",
    run: `AGENT="\${{ inputs.agent }}"
# Exported (not just a local shell var) so MCP tool-server subprocesses
# spawned by \`atoma run\` below can read the current agent's name, e.g. to
# tag artifacts they create (PRs, issues) with their origin agent.
export AGENT

# Exported because the invocation below passes each one explicitly to \`env\`, and a
# step's \`env:\` block is present in the shell's environment already -- this makes
# the dependency visible rather than implicit.
export GITHUB_RUN_ID ISSUE_NUMBER ISSUE_NOTIFY ATOMA_RUN_TYPE ATOMA_OPS_LOG

TOOLS_ARG=""
if [ -f "${MACHINERY}/${TOOLS_FILE}" ]; then
  TOOLS_ARG="--tools-file ${MACHINERY}/${TOOLS_FILE}"
fi

# Settings, not credentials. These two are repository VARIABLES -- which provider
# to use and which host to reach -- so they belong in the environment; the
# credentials do not, and are not here any more.
#
# Each is re-exported only when non-empty: exporting an empty ATOMA_PROVIDER would
# defeat Atoma's provider auto-detection.
for name in OPENAI_BASE_URL ATOMA_PROVIDER; do
  eval "value=\\\${\${name}_IN:-}"
  if [ -n "$value" ]; then
    export "\${name}=\${value}"
  fi
done

# No --prompt-file or stdin is needed: the cached session contains both stable
# GitHub context and the agent's chronological working history.
# Run as the user the tool servers will inherit. Every server atoma starts is a
# child of this process, so one \`sudo -u\` here is what puts all of them on that
# user -- there is nothing per-server to configure or to forget.
#
# \`env\` in front rather than \`--preserve-env\`: the latter needs a sudoers
# permission that a self-hosted runner may not grant, and both were measured, so
# the portable one is used. Only what a server actually reads is passed; the
# credentials are not here at all, they are in the file atoma deletes.
#
# HOME stays the runner's so the toolchain resolves. It is not writable by this
# user, uniformly for every tool, and the caches are redirected below.
# Built as an array so a setting that is EMPTY is not passed at all. \`env NAME=\`
# sets the empty string, and atoma reads an empty base URL as a base URL -- which
# would defeat the guard above and point every request at "/chat/completions".
AGENT_ENV=(
  HOME="$HOME"
  PATH="$PATH"
  AGENT="$AGENT"
  ATOMA_MACHINERY_ROOT="$ATOMA_MACHINERY_ROOT"
  GITHUB_REPOSITORY="$GITHUB_REPOSITORY"
  BRANCH="\${BRANCH:-}"
  ISSUE_NUMBER="$ISSUE_NUMBER"
  ISSUE_NOTIFY="$ISSUE_NOTIFY"
  ATOMA_RUN_TYPE="$ATOMA_RUN_TYPE"
  ATOMA_OPS_LOG="$ATOMA_OPS_LOG"
  # Caches, because $HOME is read-only to this user. CARGO_HOME is not a cache
  # directory -- redirecting it also hides ~/.cargo/config.toml -- but cargo has no
  # separate cache variable, and a project needing that config can commit
  # .cargo/config.toml, which cargo reads from the work tree.
  XDG_CACHE_HOME="${TOOL_CACHE}"
  XDG_CONFIG_HOME="${TOOL_CACHE}/config"
  XDG_DATA_HOME="${TOOL_CACHE}/data"
  BUN_INSTALL_CACHE_DIR="${TOOL_CACHE}/bun"
  npm_config_cache="${TOOL_CACHE}/npm"
  PIP_CACHE_DIR="${TOOL_CACHE}/pip"
  CARGO_HOME="${TOOL_CACHE}/cargo"
)
for name in OPENAI_BASE_URL ATOMA_PROVIDER; do
  eval "value=\\\${\${name}:-}"
  if [ -n "$value" ]; then AGENT_ENV+=("\${name}=\${value}"); fi
done

EXIT_CODE=0
sudo -n -u "${TOOL_USER}" env "\${AGENT_ENV[@]}" \\
  atoma run \\
  --agent-def "${MACHINERY}/${AGENT_DEF_DIR}/\${AGENT}.md" \\
  --in-session "${RUN_DIR}/session.json" \\
  --out-session "${RUN_DIR}/session.json" \\
  --template "${MACHINERY}/${PROMPT_TEMPLATE}" \\
  --skills-dir "${MACHINERY}/${SKILLS_DIR}" \\
  --max-iterations "${cfgStep.outputs.max_iterations}" \\
  --credentials-file "${CREDENTIALS_FILE}" \\
  \${TOOLS_ARG} \\
  > "${RUN_DIR}/atoma_output.txt" 2> "${RUN_DIR}/atoma_logs.txt" || EXIT_CODE=$?

echo "=== Atoma Logs ===" >&2
cat "${RUN_DIR}/atoma_logs.txt" >&2

if [ "$EXIT_CODE" = "2" ]; then
  echo "::notice::Max iterations reached — session saved for next run"
  echo "max_iterations_reached=true" >> "$GITHUB_OUTPUT"
elif [ "$EXIT_CODE" != "0" ]; then
  exit $EXIT_CODE
fi

# Store multiline result as a step output.
# Use a random delimiter to prevent early termination if the agent
# output happens to contain the delimiter string on its own line.
RESULT_EOF=$(dd if=/dev/urandom bs=15 count=1 status=none | base64)
{
  echo "result<<\${RESULT_EOF}"
  cat "${RUN_DIR}/atoma_output.txt"
  echo "\${RESULT_EOF}"
} >> "$GITHUB_OUTPUT"

${scriptCommandWithArgs(extractDirectiveRef, { "output-file": `${RUN_DIR}/atoma_output.txt`, "def-dir": `${MACHINERY}/${AGENT_DEF_DIR}` })}

# Detect whether a tool call already triggered an automatic follow-up
# dispatch during this run (atoma__launch_sub_agent, github__create_pr ->
# reviewer, github__merge_pr -> orchestrator-or-re-invoked-agent), as
# opposed to the agent genuinely finishing with nothing further happening.
# Every dispatch site writes a structured \`{"op":"dispatch",...}\` entry to
# the ops log (see lib/ops-log.ts's logDispatch()) -- checking for that one
# stable, documented JSON field is far more robust than the previous
# approach (grepping the agent's raw stderr TEXT for hand-written
# strings like "dispatched: agent=..."), which silently broke once already
# when a refactor changed a log message's wording without updating the grep
# pattern to match.
CHAIN_CONTINUES=false
if [ -f "${RUN_DIR}/atoma_ops.log" ] && grep -q '"op":"dispatch"' "${RUN_DIR}/atoma_ops.log"; then
  CHAIN_CONTINUES=true
fi
echo "chain_continues=\${CHAIN_CONTINUES}" >> "$GITHUB_OUTPUT"
`,
  },
  ["result", "directive", "max_iterations_reached", "chain_continues"] as const,
);

const tokenUsageStep = new TypedOutputsStep({
  name: "Write token usage summary",
  // `hashFiles` resolves relative to GITHUB_WORKSPACE and cannot see outside it,
  // so it stopped being usable when the log moved out of the work tree. Dropping
  // it costs nothing: the body already tolerates a missing file -- the `grep`
  // swallows its own error and the empty check exits 0 -- so the guard was
  // restating what the script does.
  if: "always()",
  shell: "bash",
  run: `USAGE_LINE=$(grep -m1 "ATOMA_TOKEN_USAGE:" "${RUN_DIR}/atoma_logs.txt" 2>/dev/null || true)
if [ -z "$USAGE_LINE" ]; then
  exit 0
fi
PROMPT=$(echo "$USAGE_LINE"     | grep -oP 'prompt=\\K[0-9]+' || true)
COMPLETION=$(echo "$USAGE_LINE" | grep -oP 'completion=\\K[0-9]+' || true)
TOTAL=$(echo "$USAGE_LINE"      | grep -oP 'total=\\K[0-9]+' || true)
{
  echo "## Atoma Token Usage"
  echo "| Agent | Prompt | Completion | Total |"
  echo "|------------|--------|------------|-------|"
  echo "| \${{ inputs.agent }} | \${PROMPT:-—} | \${COMPLETION:-—} | \${TOTAL:-—} |"
} >> "$GITHUB_STEP_SUMMARY"
`,
});

const postResultCommentStep = new TypedOutputsStep(
  {
    // post-result-comment's own guard (atoma outcome == success &&
    // new_event_count != '0') is sufficient: it always posts the agent's
    // final response as a comment when the run actually did something. Do
    // NOT gate the comment itself on `directive` being empty -- that shape
    // is indistinguishable from a normal "nothing more to do" completion
    // AND from an important final summary (e.g. orchestrator aggregation),
    // so gating on it would silently drop real summaries/notifications
    // instead of just reducing noise. The "please review" notice inside
    // the comment is separately suppressed via `chain_continues` (set when
    // a tool call, e.g. launch_sub_agent or create_pr, already triggered an
    // automatic follow-up run) -- that is a purpose-built signal, not a
    // reuse of the ambiguous `directive` emptiness.
    name: "Post result comment",
    id: "post-result",
    if: `${runAgentStep.rawOutcome} == 'success' && ${buildContextStep.rawOutputs.new_event_count} != '0'`,
    shell: "bash",
    env: { GH_TOKEN: "${{ github.token }}" },
    run: `${scriptCommandWithArgs(postResultCommentRef, {
      number: "${{ inputs.number }}",
      agent: "${{ inputs.agent }}",
      // Says whether `number` is an issue or a pull request, so the mention
      // decision can read the issue's own state without asking `gh issue view`
      // about a pull request.
      type: "${{ inputs.type }}",
      notify: notifyStep.outputs.notify,
      directive: runAgentStep.outputs.directive,
      "chain-continues": runAgentStep.outputs.chain_continues,
      "max-iterations-reached": runAgentStep.outputs.max_iterations_reached,
      "run-url": "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      // Passed in, because the script used to open these by their bare names --
      // relative paths that stopped resolving when #487 moved the run's files out
      // of the work tree, and every result comment since was dropped in silence.
      output: `${RUN_DIR}/atoma_output.txt`,
      "logs-file": `${RUN_DIR}/atoma_logs.txt`,
    })}\n`,
  },
  ["comment_id"] as const,
);

const recordRunMetadataStep = new TypedOutputsStep({
  // Both the comment-tagging and context-snapshot-recording halves of
  // record_run_metadata.ts only apply when a result comment was actually
  // posted -- which (per postResultCommentStep's own guard above) only
  // happens exactly when new_event_count != '0', so gating on comment_id
  // here covers both original composite-action steps' separate conditions
  // in one go.
  name: "Record run metadata",
  if: `${runAgentStep.rawOutcome} == 'success' && ${postResultCommentStep.rawOutputs.comment_id} != ''`,
  shell: "bash",
  run: `${scriptCommandWithArgs(recordRunMetadataRef, {
    session: `${RUN_DIR}/session.json`,
    "comment-id": postResultCommentStep.outputs.comment_id,
    agent: "${{ inputs.agent }}",
    "snapshot-hash": buildContextStep.outputs.context_snapshot_hash,
    "event-count": buildContextStep.outputs.context_event_count,
    type: fetchEventsStep.outputs.resolved_type,
    "resolved-number": fetchEventsStep.outputs.resolved_number,
  })}\n`,
});

const saveSessionStep = new TypedOutputsStep({
  name: "Save session to atoma-data branch",
  if: `${runAgentStep.rawOutcome} == 'success'`,
  shell: "bash",
  run: `${scriptCommandWithArgs(saveAgentSessionRef, {
    session: `${RUN_DIR}/session.json`,
    type: fetchEventsStep.outputs.resolved_type,
    number: fetchEventsStep.outputs.resolved_number,
    agent: "${{ inputs.agent }}",
  })}\n`,
});

const reportFailureStep = new TypedOutputsStep({
  name: "Report failure",
  // `always()` is required here, not just the "job.status != 'success'"
  // condition alone: without an explicit always()/failure()/success() call
  // anywhere in a step's `if:`, GitHub Actions implicitly ANDs the whole
  // condition with `success()` -- which is exactly false once a prior step
  // (e.g. "Run agent" itself) has genuinely failed, so without `always()`
  // this step -- whose entire purpose is to report THAT failure -- would
  // never run after the one case it exists for.
  if: "always() && job.status != 'success'",
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ inputs.number }}",
    AGENT: "${{ inputs.agent }}",
    NOTIFY: notifyStep.outputs.notify,
    RUN_URL: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
  },
  run: `if [ -z "$NUMBER" ]; then
  echo "::error::Cannot post failure comment: issue/PR number unknown."
  exit 0
fi
AGENT_LABEL="\${AGENT:+\${AGENT} }Atoma"
ERR_MSG=""
if [ -f "${RUN_DIR}/atoma_logs.txt" ]; then
  # Redacted before it becomes a comment. The agent's stderr log holds every MCP
  # server's stderr, and \`unauthorized\` -- one of the words grepped for here --
  # is exactly the line a provider or a \`gh\` call emits WITH the credential in
  # it. GitHub masks registered secrets in the workflow log and does nothing for
  # an issue comment, so this excerpt would arrive in the clear.
  #
  # Shape patterns only: this step holds no credential values, and handing it
  # some so it could match them literally would put them in one more process's
  # environment to protect one comment. A failure to redact yields no excerpt
  # rather than a raw one.
  ERR_MSG=$(grep -iP 'error|fail|panic|exception|unauthorized' "${RUN_DIR}/atoma_logs.txt" | head -n 5 | ${scriptCommand(redactStreamRef)} || true)
fi
MENTION=""
if [ -n "$NOTIFY" ]; then
  MENTION="@\${NOTIFY} - "
fi
BD=$(mktemp)
echo "\${MENTION}Warning: \${AGENT_LABEL} encountered an error." > "$BD"
echo "Please check the reason and retry if necessary." >> "$BD"
echo "Workflow logs: \${RUN_URL}" >> "$BD"
if [ -n "$ERR_MSG" ]; then
  echo "" >> "$BD"
  echo "Error messages detected from logs (excerpt):" >> "$BD"
  printf '\`\`\`\\n' >> "$BD"
  echo "\${ERR_MSG}" >> "$BD"
  printf '\`\`\`\\n' >> "$BD"
fi
gh issue comment "$NUMBER" --body-file "$BD"
rm -f "$BD"
`,
});

const dirtyStep = new TypedOutputsStep(
  {
    name: "Check for uncommitted changes",
    id: "dirty",
    if: `${runAgentStep.rawOutcome} == 'success'`,
    shell: "bash",
    run: `if [ -n "$(git status --porcelain)" ]; then
  echo "has_changes=true" >> "$GITHUB_OUTPUT"
fi
`,
  },
  ["has_changes"] as const,
);

const loopControlStep = new TypedOutputsStep(
  {
    name: "Manage auto-dispatch loop control",
    id: "loop-control",
    if: `${runAgentStep.rawOutcome} == 'success'`,
    shell: "bash",
    env: { GH_TOKEN: "${{ github.token }}" },
    // The target number and nothing else. The tally is counted from that object's
    // comments rather than carried in the session, so `new_event_count` and the
    // directive are no longer inputs -- see `domain/dispatch-chain.ts` for why the
    // stored counter could never reach 1.
    //
    // This must stay AFTER `postResultCommentStep`: the tally includes this run's
    // own result comment, so counting before it is posted is counting one short.
    run: `${scriptCommandWithArgs(manageDispatchLoopRef, {
      number: "${{ inputs.number }}",
    })}\n`,
  },
  ["auto_dispatch_count", "loop_limit_reached", "handoff_limit"] as const,
);

// Whether the atoma/in-progress SerializationGuard should be released after
// this run is a real domain decision (see domain/serialization-guard.ts's
// shouldReleaseGuard() for the actual rule + rationale), not something to
// express as a hand-built GitHub Actions `if:` boolean expression. This
// step computes that decision once via the shared, unit-tested domain
// function and exposes it as a single `should_release` output -- it must
// run with `always()` since the decision (rule 1: any non-success outcome
// releases the guard) needs to fire even when "Run agent" itself failed or
// was skipped.
const decideGuardReleaseStep = new TypedOutputsStep(
  {
    name: "Decide whether to release the in-progress guard",
    id: "decide-guard-release",
    if: "always()",
    shell: "bash",
    run: `${scriptCommandWithArgs(decideGuardReleaseRef, {
      outcome: runAgentStep.outcome,
      "max-iterations-reached": runAgentStep.outputs.max_iterations_reached,
      "loop-limit-reached": loopControlStep.outputs.loop_limit_reached,
      "chain-continues": runAgentStep.outputs.chain_continues,
      directive: runAgentStep.outputs.directive,
    })}\n`,
  },
  ["should_release"] as const,
);

const removeLabelStep = new TypedOutputsStep({
  name: "Remove atoma/in-progress label on completion",
  if: `always() && ${decideGuardReleaseStep.rawOutputs.should_release} == 'true'`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ inputs.number }}",
  },
  run: `${scriptCommandWithArgs(manageInProgressLabelRef, { action: "remove", number: "\${NUMBER}" })}
`,
});

const DISPATCH_NEXT_GUARD =
  `${runAgentStep.rawOutcome} == 'success' && ${runAgentStep.rawOutputs.directive} != '' && ` +
  `${runAgentStep.rawOutputs.max_iterations_reached} != 'true'`;

const dispatchNextAgentStep = new TypedOutputsStep({
  name: "Dispatch next agent",
  if: `${DISPATCH_NEXT_GUARD} && ${loopControlStep.rawOutputs.loop_limit_reached} != 'true'`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    DIRECTIVE: runAgentStep.outputs.directive,
    NUMBER: "${{ inputs.number }}",
    TYPE: "${{ inputs.type }}",
    NOTIFY: notifyStep.outputs.notify,
  },
  run: `if ! [[ "$DIRECTIVE" =~ ^${AGENT_NAME_PATTERN}$ ]]; then
  echo "::error::Invalid directive value: \${DIRECTIVE}"
  exit 1
fi

echo "Dispatching '\${DIRECTIVE}' on \${TYPE} #\${NUMBER} via atoma-runner.yml ..."
# Use gh workflow run with the current GH_TOKEN (caller's token, e.g. from issue_comment event).
# This preserves the caller's token permissions (PR creation OK for issue_comment events).
gh workflow run atoma-runner.yml \\
  --field agent="$DIRECTIVE" \\
  --field number="$NUMBER" \\
  --field type="$TYPE" \\
  --field notify="$NOTIFY"
`,
});

const loopLimitCommentStep = new TypedOutputsStep({
  name: "Comment on loop limit reached",
  if: `${DISPATCH_NEXT_GUARD} && ${loopControlStep.rawOutputs.loop_limit_reached} == 'true'`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ inputs.number }}",
    DIRECTIVE: runAgentStep.outputs.directive,
    NOTIFY: notifyStep.outputs.notify,
    RUN_URL: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    // Both read from the step that decided, not written here. The limit is
    // configurable now, so a literal spliced in at synth time would tell a person
    // a number that is not the one that stopped their chain -- which is the defect
    // the old constant's own comment warned about, made reachable.
    COUNT: loopControlStep.outputs.auto_dispatch_count,
    LIMIT: loopControlStep.outputs.handoff_limit,
  },
  run: `if [ -n "$NUMBER" ]; then
  MENTION=""
  if [ -n "$NOTIFY" ]; then
    MENTION="@\${NOTIFY} - "
  fi
  BD=$(mktemp)
  echo "\${MENTION}Auto-dispatch loop limit reached: \${COUNT} agent handoffs since anyone else commented (limit \${LIMIT})." > "$BD"
  echo "To prevent unintended infinite agent loops and excessive API costs, further automatic handoff (next agent: \${DIRECTIVE}) has been safely suppressed." >> "$BD"
  echo "Please review the progress so far. To resume, post a manual comment on the Issue/PR (e.g. /\${DIRECTIVE}) to trigger the next agent at any time." >> "$BD"
  echo "See the workflow run for details: \${RUN_URL}." >> "$BD"
  gh issue comment "$NUMBER" --body-file "$BD"
  rm -f "$BD"
fi
`,
});

// Traceability + visibility: post an explicit "review starting" marker on
// the PR as soon as the reviewer is about to run, regardless of what
// dispatched it (github__create_pr's own dispatch, the pull_request auto-
// trigger workflows, or a manual /reviewer comment) -- one single place
// covering every path, rather than duplicating this in each dispatcher.
// The atoma/in-progress label (added just above, before this step) already
// gives ongoing at-a-glance status; this comment gives a concrete, timestamped
// entry in the PR's own history of a review actually starting.
const reviewerStartCommentStep = new TypedOutputsStep({
  name: "Post reviewer-start comment",
  if: `${buildContextStep.rawOutputs.new_event_count} != '0' && inputs.agent == 'reviewer' && inputs.type == 'pr'`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ inputs.number }}",
  },
  run: `gh issue comment "$NUMBER" --body "${LLM_CONTEXT_TAG.write("exclude")}
Atoma: reviewer starting review."
`,
});

const runJob = new NormalJob("run", {
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 60,
  concurrency: {
    group: "atoma-${{ inputs.type }}-${{ inputs.number }}",
    "cancel-in-progress": false,
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
  // `ATOMA_MACHINERY_ROOT` is deliberately NOT a job-level `env:` any more. It used
  // to be, set to the relative `atoma-machinery`, and the step that moves the
  // machinery out of the work tree then wrote the absolute path to `$GITHUB_ENV`.
  //
  // That worked only if the env file wins over a job-level `env:` -- which it does,
  // but a run where it did not would break every path in every step at once, and
  // the failure would look like a bad release rather than a precedence question. So
  // there is one source: the move step writes it, and the three steps before that
  // one (validate, make the run directory, checkout) do not read it.
}).addSteps([
  // First, before the checkout: nothing should run at all on an input this job
  // is going to splice into shell text.
  validateInputsStep,
  // Before the checkout, because it has nothing to do with the checkout: this is a
  // directory in the runner's temp space, and putting it first means no later
  // reordering can leave a writer ahead of it.
  //
  // It has to be here rather than in the step that creates the tool user, which is
  // where the ACL below is added. Three steps write into this directory before that
  // user exists -- "Fetch GitHub events", "Restore agent session" and "Merge GitHub
  // context" -- so creating it there would fail all three.
  new TypedOutputsStep({
    name: "Make a place for this run's own files",
    shell: "bash",
    run: `mkdir -p "${RUN_DIR}"
echo "this run's files: ${RUN_DIR}"
`,
  }),
  new ActionsCheckoutV4({
    name: "Checkout repository",
    with: {
      ref: "${{ inputs.type == 'pr' && format('refs/pull/{0}/head', inputs.number) || '' }}",
    },
  }),
  new ActionsCheckoutV4({
    name: "Checkout the delivery machinery from the default branch",
    with: { ref: "${{ github.event.repository.default_branch }}", path: MACHINERY_DIR },
  }),
  // Straight out again, before any step reads it. `actions/checkout` cannot write
  // outside `GITHUB_WORKSPACE`, so this is the only way for the machinery to end up
  // somewhere `git status` does not see -- and `git status` seeing it was the whole
  // problem. See MACHINERY_ABS.
  //
  // Rewriting the variable rather than the paths that use it: every step reads
  // `${ATOMA_MACHINERY_ROOT}`, including the agent step, which passes it through to
  // the tool servers. One assignment moves all of them.
  new TypedOutputsStep({
    name: "Move the machinery out of the work tree",
    shell: "bash",
    run: `rm -rf "${MACHINERY_ABS}"
mv "${MACHINERY_DIR}" "${MACHINERY_ABS}"
echo "ATOMA_MACHINERY_ROOT=${MACHINERY_ABS}" >> "$GITHUB_ENV"
echo "machinery moved to ${MACHINERY_ABS}; the work tree holds only the repository"
`,
  }),
  new TypedOutputsStep({
    name: "Set branch env for PR type",
    if: "inputs.type != 'issue'",
    shell: "bash",
    run: `echo "BRANCH=$(git rev-parse --abbrev-ref HEAD)" >> $GITHUB_ENV
`,
  }),
  // Required for every subsequent step / the "Run agent" step itself
  // (tools.yaml spawns the atoma MCP servers via `bun run ...`) --
  // GitHub-hosted runners do not ship Bun preinstalled.
  new SetupBunAction({ name: "Setup Bun" }),
  // The two branch steps sit after Bun and before everything that reads the
  // working tree: they run Atoma's own scripts, and a later checkout would swap
  // the files under steps that already inspected them.
  //
  // No branch is created here. Most runs never commit -- reporting a CI failure,
  // confirming a merge, closing an issue -- and creating one for those left a
  // branch behind per run. `commit_and_push` names one when a run turns out to
  // need it.
  //
  // Deciding by what a run does rather than by which agent it is: agents are the
  // adopter's to rename, edit and add to, so nothing may key off an agent's name.
  resolveIssueBranchStep,
  new TypedOutputsStep({
    name: "Check out the branch this run starts from",
    if: "inputs.type == 'issue'",
    shell: "bash",
    env: { BRANCH_NAME: resolveIssueBranchStep.outputs.branch },
    // Resuming sets BRANCH; starting from the base deliberately does not. BRANCH
    // is what `create_pr` reads as the head branch, and naming the base there
    // would open a pull request from the base onto itself. With it unset, the
    // branch `commit_and_push` creates is read back from HEAD.
    run: `if [ -z "\${BRANCH_NAME}" ]; then
  BRANCH_NAME=$(${scriptCommand(getConfigValueRef, configValueArgv("base_branch", ""))})
  [ -n "\${BRANCH_NAME}" ] || exit 0
else
  echo "BRANCH=\${BRANCH_NAME}" >> $GITHUB_ENV
fi
git fetch origin "refs/heads/\${BRANCH_NAME}:refs/remotes/origin/\${BRANCH_NAME}"
git checkout -B "\${BRANCH_NAME}" "refs/remotes/origin/\${BRANCH_NAME}"
`,
  }),
  // MCP サーバーパッケージのキャッシュ + グローバルインストール
  // npm のダウンロードキャッシュを保存し、`npm install -g` を高速化
  new CacheAction({
    name: "Cache MCP server package downloads",
    with: {
      path: "~/.npm",
      key: "mcp-npm-${{ hashFiles('" + MACHINERY_DIR + "/.github/atoma/mcp-packages.json') }}",
      "restore-keys": "mcp-npm-",
    },
  }),
  new TypedOutputsStep({
    name: "Install MCP server packages",
    shell: "bash",
    run: `MCP_PKGS_FILE="${MACHINERY}/.github/atoma/mcp-packages.json"
if [ ! -f "$MCP_PKGS_FILE" ]; then
  echo "No mcp-packages.json found; skipping MCP package installation."
  exit 0
fi

# Executables a tool server is started by name, installed globally.
NPM_PKGS=$(jq -r '.npm[]? // empty' "$MCP_PKGS_FILE" 2>/dev/null || true)
if [ -n "$NPM_PKGS" ]; then
  echo "Installing npm MCP packages: $NPM_PKGS"
  for pkg in $NPM_PKGS; do
    npm install -g "$pkg"
  done
  # Put the global bin directory on PATH so those names resolve.
  NPM_BIN=$(npm prefix -g)/bin
  echo "$NPM_BIN" >> "$GITHUB_PATH"
  echo "Added npm global bin to PATH: $NPM_BIN"
fi

# Packages a bundled script imports rather than spawns.
#
# The npm list above installs executables globally, which is right for a server
# started by name. This list is for libraries a tool server imports; they are
# excluded from the bundle because they reach native code a JavaScript bundler
# cannot carry, so they have to be resolvable at run time.
#
# Installed NEXT TO THE MACHINERY, not in the work tree. Module resolution walks
# up from the importing file looking for \`node_modules\`, and the servers now live
# in \`$RUNNER_TEMP/atoma-machinery\` -- so the walk goes to \`$RUNNER_TEMP\` and stops
# at the root, never reaching the workspace. This was measured, not reasoned about:
# moving the machinery out (#493) killed the search server with
#
#   Failed to initialize MCP server 'search': MCP server closed connection
#   error: Unexpected while resolving package 'onnxruntime-common'
#
# and atoma treats a server that will not initialise as fatal, so one missing
# library took the whole run down.
#
# Separate from the project's own \`node_modules\` is the better arrangement anyway.
# A project whose \`environment.setup_commands\` install a conflicting version of one
# of these would otherwise break a tool server, and nothing would connect the two.
BUN_PKGS=$(jq -r '.bun[]? // empty' "$MCP_PKGS_FILE" 2>/dev/null || true)
if [ -n "$BUN_PKGS" ]; then
  echo "Installing bun MCP libraries: $BUN_PKGS"
  # A manifest of its own, so \`bun add\` has somewhere to work and does not read a
  # project's. \`--no-save\` still applies; this only gives it a directory to own.
  if [ ! -f "\${RUNNER_TEMP}/package.json" ]; then
    echo '{"name":"atoma-mcp-libraries","private":true}' > "\${RUNNER_TEMP}/package.json"
  fi
  (cd "\${RUNNER_TEMP}" && bun add --no-save $BUN_PKGS)
  echo "MCP libraries installed at \${RUNNER_TEMP}/node_modules, beside the machinery"
fi

# Python packages, for a tool server that ships as one.
PIP_PKGS=$(jq -r '.pip[]? // empty' "$MCP_PKGS_FILE" 2>/dev/null || true)
if [ -n "$PIP_PKGS" ]; then
  echo "Installing pip MCP packages: $PIP_PKGS"
  for pkg in $PIP_PKGS; do
    pip install "$pkg"
  done
fi
`,
  }),
  // Hooks are the one part of the tool tree that has to be directly executable.
  // `tools.yaml` names a `before_tool` hook by path and Atoma spawns it as a
  // program, so it runs via its shebang and needs its exec bit. Everything else
  // is launched as `bun run <path>`, where the file mode is irrelevant.
  //
  // Set here on every run rather than trusted from the checkout, because the mode
  // is decided wherever the repository was committed from, not where it runs. Git
  // records new files as non-executable on a filesystem with no POSIX exec bit --
  // Windows, where `core.filemode` defaults to false -- and the loss is invisible
  // until a tool call fails. `before_tool` is fail-closed, so a hook that cannot
  // start denies the tool outright rather than degrading it.
  //
  // `find -exec` and not a glob: the directory is allowed to be empty, and a glob
  // that matches nothing would hand `chmod` a literal `*.ts` and fail the step.
  new TypedOutputsStep({
    name: "Make tool hooks executable",
    shell: "bash",
    run: `if [ -d "${MACHINERY}/${TOOL_HOOKS_DIR}" ]; then
  find "${MACHINERY}/${TOOL_HOOKS_DIR}" -name '*.ts' -exec chmod +x {} +
fi
`,
  }),
  // No separate "install MCP server dependencies" step needed: build-dist.ts
  // bundles every script (via Bun.build) with all its imports -- including
  // npm dependencies like @modelcontextprotocol/sdk -- inlined
  // into a single self-contained file, so the deployed `.github/atoma/tools/scripts/**`
  // needs no package.json/node_modules/bun install at all.
  environmentSetupStep(),
  new TypedOutputsStep({
    name: "Configure git identity",
    shell: "bash",
    run: `git config user.name "atoma-\${{ inputs.agent }}"
git config user.email "atoma-\${{ inputs.agent }}@users.noreply.github.com"
`,
  }),
  notifyStep,
  fetchEventsStep,
  restoreSessionStep,
  // Before the step that creates the tool user, and that is fine: the ACL pass
  // there is `-R`, so it reaches what this already unpacked. Putting it after would
  // work too -- what would NOT work is a `-d`-only ACL, which never touches a file
  // that already exists. See the comment beside those setfacl lines.
  restoreWorkspaceStep,
  buildContextStep,
  cfgStep,
  new TypedOutputsStep({
    // Added BEFORE the agent actually runs (not after) so it's visible to a
    // human for the entire duration of the run, not just flickered on/off
    // afterwards. Applies to both issues and PRs -- `gh issue edit` works on
    // PR numbers too since GitHub treats every PR as an issue under the
    // hood. Gated on the same condition as "Run agent" so the label isn't
    // added for no-op runs that will be skipped entirely
    // (new_event_count == '0').
    name: "Add atoma/in-progress label",
    if: `${buildContextStep.rawOutputs.new_event_count} != '0'`,
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      NUMBER: "${{ inputs.number }}",
    },
    run: `${scriptCommandWithArgs(manageInProgressLabelRef, { action: "add", number: "\${NUMBER}" })}
`,
  }),
  reviewerStartCommentStep,
  checkoutAtomaSourceStep,
  installAtomaCli,
  // Put every tool server on one OS user that cannot become root.
  //
  // AFTER environment setup, because that is what installs the toolchain this
  // user then has to be able to reach.
  //
  // This replaced a rootless podman container and the seventy lines that built it
  // -- an overlay of $HOME, a generated /etc/passwd, subordinate id ranges, a
  // newuidmap shim. #464 has the measurements; the decision in one paragraph:
  //
  // Three things cannot all be true -- every tool sees the same environment, a
  // credential in one tool is hidden from the shell, and any third-party server
  // works. The container chose the second by giving up the first, and the cost
  // was silent: a write to $HOME inside it succeeded and then was not there for
  // any other tool, in 18 of 2,118 measured shell calls. An agent cannot reason
  // about a write that reports success and does not persist.
  //
  // So: one user for all of them, so no tool's environment differs from another's.
  // Not in sudoers, because with sudo nothing else matters -- `sudo cat
  // /proc/<pid>/environ` reads anything, whatever else is arranged. That single
  // fact is why the flag atoma sets on itself, the PATH narrowing in the servers,
  // and everything else here only mean something for a user without sudo.
  //
  // Three mechanics, each measured on this runner before being written here:
  //
  //   The user. `-M` no home, nologin: it is never logged into, only `sudo -u`'d
  //   into. `-U` gives it a group of its own -- the probe used `-N`, which falls
  //   back to the shared `users` group, and a shared group is a way to inherit
  //   permissions nobody intended. That is the one flag here not measured as
  //   written; every other property was.
  //
  //   Reaching the work tree. It lives under the runner's HOME, which is 750, so
  //   the user cannot get to it by mode alone. An ACL grants `x` -- traverse
  //   without listing -- on each directory down to the workspace, and `rwX` inside
  //   it including as a DEFAULT so files and directories created later inherit it.
  //   Measured: the user creates a file, the runner then edits it IN PLACE, which
  //   is what `filesystem__edit_file` does and what a shared group with umask 002
  //   could not guarantee -- a command can call `umask` and undo that.
  //
  //   A writable cache. $HOME stays read-only to this user, uniformly for every
  //   tool, so a write there fails instead of appearing to work. Package managers
  //   need somewhere real, so the caches are redirected by the environment the
  //   agent step passes.
  new TypedOutputsStep({
    name: "Put the tool servers on a user without sudo",
    shell: "bash",
    run: `sudo useradd -M -U -s /usr/sbin/nologin "${TOOL_USER}" 2>/dev/null || true
id "${TOOL_USER}"

# Traverse-only down to the workspace, walked rather than hardcoded: the path
# between HOME and the workspace is the runner's business, not ours.
DIR="$GITHUB_WORKSPACE"
while [ "$DIR" != "/" ]; do
  DIR=$(dirname "$DIR")
  # Stop before "/" itself, and before anything world-traversable already: a
  # self-hosted runner's workspace is often nowhere near $HOME, and walking to the
  # root would put an ACL on "/".
  [ "$DIR" = "/" ] && break
  sudo setfacl -m "u:${TOOL_USER}:x" "$DIR"
  [ "$DIR" = "$HOME" ] && break
done

# Full access inside the tree, and as a default so later files inherit it. \`X\`
# rather than \`x\`: execute on directories, not on every file.
sudo setfacl -R -m "u:${TOOL_USER}:rwX" "$GITHUB_WORKSPACE"
sudo setfacl -R -d -m "u:${TOOL_USER}:rwX" "$GITHUB_WORKSPACE"
sudo setfacl -R -d -m "u:$(id -un):rwX" "$GITHUB_WORKSPACE"

# Somewhere real for the caches, since $HOME is not writable by this user.
sudo install -d -o "${TOOL_USER}" -m 0700 "${TOOL_CACHE}"

# The run's own directory, handed to the tool user now that it exists. \`atoma run\`
# writes the session as that user while the runner wrote it moments before, and the
# runner reads it back afterwards -- so both need access, to files that do not exist
# yet. Hence the default ACLs: whatever either one creates in here, the other can
# read and write.
# \`-R\` as well as \`-d\`, and the difference matters here more than it does for the
# work tree. A default ACL applies to files created AFTER it is set, and three
# steps have already written into this directory by now -- the session among them,
# which \`atoma run\` is about to open for writing as the tool user. Without the
# recursive pass that file keeps the mode \`mkdir\` gave it and the write fails.
sudo setfacl -R -m "u:${TOOL_USER}:rwX" "${RUN_DIR}"
sudo setfacl -R -d -m "u:${TOOL_USER}:rwX" "${RUN_DIR}"
sudo setfacl -R -d -m "u:$(id -un):rwX" "${RUN_DIR}"

# The agent's scratch workspace, on the same terms. The runner unpacks into it
# before the agent starts and packs it up afterwards, and everything the agent does
# in it happens as the tool user -- so both need to read and write what the other
# creates, including files that do not exist yet.
#
# \`/tmp\` is already world-writable, so this is not what makes the directory
# usable; it is what stops the two identities tripping over each other's file
# modes inside it.
# The machinery, read-only. It left the work tree, which is where it used to pick
# up the tool user's access as a side effect of the recursive ACL below -- so
# without this the tool servers cannot read their own scripts and no server starts.
#
# \`rX\` rather than \`rwX\`: read everywhere, execute only where execute is already
# set for somebody. "Make tool hooks executable" ran earlier, so the hooks get it
# and the ordinary files do not. Nothing here is the agent's to modify.
sudo setfacl -R -m "u:${TOOL_USER}:rX" "$ATOMA_MACHINERY_ROOT"

# And the libraries the servers import, which sit beside the machinery for module
# resolution to find. Read-only for the same reason.
if [ -d "\${RUNNER_TEMP}/node_modules" ]; then
  sudo setfacl -R -m "u:${TOOL_USER}:rX" "\${RUNNER_TEMP}/node_modules"
fi

mkdir -p "${WORKSPACE_DIR}"
sudo setfacl -R -m "u:${TOOL_USER}:rwX" "${WORKSPACE_DIR}"
sudo setfacl -R -d -m "u:${TOOL_USER}:rwX" "${WORKSPACE_DIR}"
sudo setfacl -R -d -m "u:$(id -un):rwX" "${WORKSPACE_DIR}"

# And a directory for the credentials file that the TOOL USER owns, so atoma can
# unlink it. Owned by them, writable by us: the runner writes the file into it and
# hands it over, and the delete that keeps the file and the servers from coexisting
# then succeeds. Without this the delete fails and every credential stays readable.
sudo install -d -o "${TOOL_USER}" -m 0700 "${CREDENTIALS_DIR}"
sudo setfacl -m "u:$(id -un):rwx" "${CREDENTIALS_DIR}"

# Close the world-writable directories on PATH.
#
# The design rests on the tool user having no sudo. That is worth nothing while it
# can write a directory the RUNNER's own later steps search: this job goes on to
# run \`git status\`, \`grep\` and \`gh issue comment\` as the runner, which does have
# passwordless sudo. Measured on ubuntu-latest: /opt/pipx_bin,
# /usr/local/.ghcup/bin and /usr/local/bin are all drwxrwxrwx and all precede
# /usr/bin.
#
# Computed from PATH rather than named, so an image that adds a fourth is covered.
#
# ORDER MATTERS, and this step is placed for it: every install this job performs
# has to have happened already. The MCP packages, the environment setup -- and the
# atoma CLI itself, which is written to /usr/local/bin. That last one is why this
# step sits after "Install Atoma CLI" rather than after the environment setup: it
# did not, and the first real run failed with
#   curl: (23) Failure writing output to destination
# because the directory curl was writing into had just been closed.
for dir in \${PATH//:/ }; do
  [ -d "$dir" ] || continue
  case "$(stat -L -c '%A' "$dir" 2>/dev/null)" in
    *w?) sudo chmod go-w "$dir" && echo "closed world-writable PATH entry: $dir";;
  esac
done

# Git as the tool user, over a checkout the runner owns.
#
# \`actions/checkout\` writes this into the runner's own gitconfig, which the tool
# user can read through the traversal granted above -- but that is a default of a
# third-party action, and \`github__commit_and_push\` and every \`git\` the agent runs
# depend on it. Said explicitly, at system level, so it does not.
sudo git config --system --add safe.directory "$GITHUB_WORKSPACE" 2>/dev/null || true

echo "tool servers will run as ${TOOL_USER} (no sudo), caches in ${TOOL_CACHE}"
`,
  }),
  // Immediately before the agent, because its output is what keys the secret
  // lookups in that step's own `env:`.
  toolSecretsStep,
  writeCredentialsStep,
  runAgentStep,
  tokenUsageStep,
  postResultCommentStep,
  recordRunMetadataStep,
  saveSessionStep,
  // Takes the root issue from the restore step rather than resolving the chain
  // again: two resolutions can disagree if a parent tag changed mid-run, and then
  // the run reads from one workspace and writes to another with nothing saying so.
  new TypedOutputsStep({
    name: "Save the agent's workspace",
    if: `${runAgentStep.rawOutcome} == 'success'`,
    shell: "bash",
    run: `${scriptCommandWithArgs(saveWorkspaceRef, {
      "root-issue": restoreWorkspaceStep.outputs.root_issue,
      source: WORKSPACE_DIR,
      agent: "${{ inputs.agent }}",
    })}\n`,
  }),
  reportFailureStep,
  dirtyStep,
  new TypedOutputsStep({
    name: "Inject uncommitted changes into session",
    if: `${dirtyStep.rawOutputs.has_changes} == 'true'`,
    shell: "bash",
    // The path, explicitly. This used to search the work tree for the first file
    // called `session.json` -- which was merely redundant while the session sat in
    // the repository root, and becomes a hazard once it does not: an adopter whose
    // project has a `session.json` of its own would get this notice appended to
    // THEIR file.
    run: `${scriptCommandWithArgs(injectUncommittedNoticeRef, { session: `${RUN_DIR}/session.json` })}\n`,
  }),
  new TypedOutputsStep({
    name: "Notify on max iterations",
    if: `${runAgentStep.rawOutputs.max_iterations_reached} == 'true'`,
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      NUMBER: "${{ inputs.number }}",
      NOTIFY: notifyStep.outputs.notify,
      AGENT: "${{ inputs.agent }}",
    },
    run: `${scriptCommandWithArgs(notifyMaxIterationsRef, { number: "\${NUMBER}", agent: "\${AGENT}", notify: "\${NOTIFY}" })}
`,
  }),
  loopControlStep,
  decideGuardReleaseStep,
  removeLabelStep,
  dispatchNextAgentStep,
  loopLimitCommentStep,
]);

export const atomaRunner = new Workflow("atoma-runner", {
  name: "Atoma Runner",
  // Cast: the generated `WorkflowDispatchInput.default` type is an upstream
  // json-schema-to-typescript quirk (typed as a generic object, not the
  // string/boolean/number the real schema allows) -- see
  // https://github.com/emmanuelnk/github-actions-workflow-ts. Structurally
  // this object is valid workflow_call/workflow_dispatch YAML.
  on: {
    workflow_call: {
      inputs: {
        agent: { description: AGENT_INPUT_DESC, required: true, type: "string" },
        number: { description: NUMBER_INPUT_DESC, required: true, type: "string" },
        type: { description: "Context type", required: true, type: "string" },
        notify: { description: NOTIFY_INPUT_DESC, required: false, type: "string", default: "" },
        session_mode: { description: SESSION_MODE_INPUT_DESC, required: false, type: "string", default: "continue" },
        atoma_version: { description: ATOMA_VERSION_DESC, required: false, type: "string", default: ATOMA_DEFAULT_VERSION },
      },
    },
    workflow_dispatch: {
      inputs: {
        agent: { description: AGENT_INPUT_DESC, required: true, type: "string" },
        number: { description: NUMBER_INPUT_DESC, required: true, type: "string" },
        type: { description: "Context type", required: true, type: "choice", options: ["issue", "pr"] },
        notify: { description: NOTIFY_INPUT_DESC, required: false, type: "string", default: "" },
        session_mode: { description: SESSION_MODE_INPUT_DESC, required: false, type: "choice", options: ["continue", "recover"], default: "continue" },
        atoma_version: { description: ATOMA_VERSION_DESC, required: false, type: "string", default: ATOMA_DEFAULT_VERSION },
      },
    },
  } as unknown as GWT.Workflow["on"],
}).addJob(runJob);

/**
 * The `workflow_call.inputs` contract above, mirrored as a TS type. This is
 * the single source of truth every caller (`atoma-entry.wac.ts`,
 * `atoma-auto-trigger.wac.ts`, `atoma-manual-comment.wac.ts`,
 * `atoma-pr-review.wac.ts`) is checked against -- required vs. optional here
 * matches `required`/`default` above, so a caller forgetting `agent` (or
 * typo-ing it) is a compile error, not a silent no-op input.
 */
export interface AtomaRunnerInputs {
  agent: string;
  number: string;
  type: string;
  notify?: string;
  session_mode?: string;
  atoma_version?: string;
}

/** Type-safe `workflow_call` invocation of this workflow from other `*.wac.ts` files. */
export const atomaRunnerWorkflow = defineCallableWorkflow<AtomaRunnerInputs>(atomaRunner);

/**
 * Every caller of this workflow (`atoma-entry`, `atoma-auto-trigger`,
 * `atoma-manual-comment`, `atoma-pr-review`) follows the exact same shape:
 * a "route" job resolves `agent`/`number`/`type`/`notify` as its own job
 * outputs, then hands off to `atoma-runner` gated on `agent` being non-empty.
 * That `needs:`/`if:`/`with:` wiring was near-identically hand-copied 4
 * times -- this collapses it to one call. The route job itself still needs
 * a name at the call site (GitHub Actions' own job graph requires a stable
 * reference to appear in both the `jobs:` map and any `needs:`/output read
 * -- no TS wrapper can make that indirection disappear, it isn't a styling
 * choice), but everything *after* that reference is now one line instead of
 * eight.
 */
export function dispatchToAtomaRunner<TOutputs extends Record<"agent" | "number" | "type" | "notify", string>>(
  routeJob: DefinedJob<TOutputs>,
  secrets?: "inherit" | Record<string, string>,
  sessionMode = "continue",
): ReturnType<typeof atomaRunnerWorkflow.call> {
  return atomaRunnerWorkflow.call("run", {
    needs: [routeJob],
    if: `${routeJob.rawOutputs.agent} != ''`,
    with: {
      agent: routeJob.outputs.agent,
      number: routeJob.outputs.number,
      type: routeJob.outputs.type,
      notify: routeJob.outputs.notify,
      session_mode: sessionMode,
    },
    secrets,
  });
}
