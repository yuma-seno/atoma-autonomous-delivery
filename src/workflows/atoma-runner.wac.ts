import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import type { GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedOutputsStep, type DefinedJob } from "./actions/base.ts";
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
import {
  OVERLAY_ROOT,
  SANDBOX_DIR,
  ref as prepareShellConfinementRef,
} from "../scripts/prepare_shell_confinement.ts";
import { ref as injectUncommittedNoticeRef } from "../scripts/inject_uncommitted_notice.ts";
import { ref as fetchEventsRef } from "../scripts/fetch_events.ts";
import { ref as restoreAgentSessionRef } from "../scripts/restore_agent_session.ts";
import { ref as reconcileGithubSessionRef } from "../scripts/reconcile_github_session.ts";
import { ref as extractDirectiveRef } from "../scripts/extract_directive.ts";
import { ref as postResultCommentRef } from "../scripts/post_result_comment.ts";
import { ref as recordRunMetadataRef } from "../scripts/record_run_metadata.ts";
import { ref as saveAgentSessionRef } from "../scripts/save_agent_session.ts";
import { LOOP_LIMIT, ref as manageDispatchLoopRef } from "../scripts/manage_dispatch_loop.ts";
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
// Moves with `tools/tools.yaml`, not independently. From v0.1.11 atoma removes
// the credentials it knows about from a tool server's environment unless that
// server names them, and expands `${NAME}` in an `env:` value against the run's
// credentials. Before v0.1.11 those values were literal, so a tools file carrying
// `${GH_TOKEN}` would hand `github` those seven characters as its token --
// overriding the value it had been inheriting and failing every call with a 401.
//
// So the two are one change: raising this pin without the declarations strips a
// token nothing asks for, and shipping the declarations without raising it passes
// a literal.
//
// v0.1.12 adds the same coupling for `args`: it expands `${NAME}` there, from the
// environment, which is how a tool server is read from the machinery checkout
// rather than from the pull request under review. To v0.1.11 an `args` entry
// carrying `${ATOMA_MACHINERY_ROOT:-.}` is a literal path that does not exist, so
// this pin and `tools/tools.yaml` move together here too.
//
// v0.1.13 is a third coupling, and this one is with the repository's SECRETS.
// Providers became a table there: `openai` means OpenAI rather than defaulting to
// OpenRouter, the routers have their own names, and each provider reads its own
// credential -- `OPENROUTER_API_KEY`, `ORCAROUTER_API_KEY` -- with no fallback to
// `OPENAI_API_KEY`. Two credentials present is an error naming both, so a
// repository that keeps an OpenRouter key under the old name AND adds it under the
// new one gets a failed run rather than a guess. Raising this pin means the secret
// has to have been renamed first.
//
// v0.1.14 gives each router a name for each dialect it serves, which is what the
// agent definitions here needed: they read `provider: openai-responses # openrouter`,
// a row that in v0.1.13 means OpenAI itself. So this pin moves with
// `agent-definitions/*.md` as well.
//
// v0.1.16 carries two fixes that are about THIS repository's runs specifically.
//
// The Responses adapter assembled its own `extra_body` merge and left out the
// reconciliation that protects the runtime tool definitions -- so an agent carrying
// `extra_body.tools` replaced them. All three definitions here carry OpenRouter's two
// server tools, and all three use that adapter, so every request sent those two and no
// MCP schema at all. The model was inferring argument shapes from the names in the
// system prompt, which is the shape of the argument failures that have been read as model
// weakness -- `issue_number` for `number`, `form` for `from`, `label` for `labels`.
//
// And a `vision: false` agent had pictures replaced before the message entered the
// session, so what atoma-data recorded was not what happened: resuming with
// `vision: true` could never get them back.
const ATOMA_DEFAULT_VERSION = "v0.1.16";
const ATOMA_VERSION_DESC = "Atoma CLI version tag to install (e.g. v0.1.7). Use `source` to build from a checkout of yuma-seno/atoma@main.";

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

/** The same directory, as shell -- the job exports it so every step agrees. */
const MACHINERY = "${ATOMA_MACHINERY_ROOT}";

const ORCHESTRATION_FILE = ".github/atoma/config.json";
const AGENT_DEF_DIR = ".github/atoma/agent-definitions";
const PROMPT_TEMPLATE = ".github/atoma/prompt-template.md";
const SKILLS_DIR = ".github/atoma/skills";
const TOOLS_FILE = ".github/atoma/tools/tools.yaml";

/**
 * Where the shell server's sandbox is assembled.
 *
 * The generated `/etc` overlays go under `$RUNNER_TEMP`, which is outside the
 * work tree so nothing commits them. The overlay itself cannot: overlayfs
 * refuses an upperdir nested inside its own lowerdir, and `$RUNNER_TEMP` lives
 * under `$HOME`. `/mnt` is the runner's scratch disk and is outside it.
 *
 * Both are written as shell rather than resolved here, because `tools.yaml`
 * needs the same two paths and expands `${NAME}` from the environment.
 */
const SHELL_SANDBOX_DIR = SANDBOX_DIR;
// The script that creates the overlay names it; this step, which mounts it, and
// `tools.yaml`, which binds it as the container's $HOME, both have to agree. Two of the
// three now share a constant, and the contract test holds the third to it -- `tools.yaml`
// is a static file an adopter receives, so it cannot import anything.
const SHELL_OVERLAY_ROOT = OVERLAY_ROOT;

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
      out: "events.json",
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
    out: "session.json",
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
      events: "events.json",
      "agent-name": "${{ inputs.agent }}",
      // Read for its `vision` field: an agent whose model cannot see a picture
      // must not be sent one.
      "agent-def": `${MACHINERY}/${AGENT_DEF_DIR}/\${{ inputs.agent }}.md`,
      config: `${MACHINERY}/${ORCHESTRATION_FILE}`,
      session: "session.json",
      out: "session.json",
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

const checkoutAtomaSourceStep = new ActionsCheckoutV4({
  name: "Checkout Atoma source (for atoma_version: source)",
  if: "inputs.atoma_version == 'source'",
  with: { repository: "yuma-seno/atoma", path: "atoma-src" },
});

const installAtomaCliStep = new TypedOutputsStep({
  name: "Install Atoma CLI",
  shell: "bash",
  run: `VERSION="\${{ inputs.atoma_version }}"
if [ "$VERSION" = "source" ]; then
  echo "Building Atoma from source (atoma-src/) ..."
  cargo install --path atoma-src --force --locked
elif [ "$VERSION" = "latest" ]; then
  URL="https://github.com/yuma-seno/atoma/releases/latest/download/atoma-linux-x86_64"
  echo "Downloading Atoma \${VERSION} ..."
  curl -fsSL "$URL" -o /usr/local/bin/atoma
  chmod +x /usr/local/bin/atoma
else
  URL="https://github.com/yuma-seno/atoma/releases/download/\${VERSION}/atoma-linux-x86_64"
  echo "Downloading Atoma \${VERSION} ..."
  curl -fsSL "$URL" -o /usr/local/bin/atoma
  chmod +x /usr/local/bin/atoma
fi
atoma --version
`,
});

/** Outside the workspace, so the checkout cannot have placed it and nothing commits it. */
const CREDENTIALS_FILE = "$RUNNER_TEMP/atoma-credentials.json";

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
  run: `${scriptCommandWithArgs(writeCredentialsFileRef, { out: CREDENTIALS_FILE })}\n`,
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
      ATOMA_OPS_LOG: "atoma_ops.log",
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
EXIT_CODE=0
atoma run \\
  --agent-def "${MACHINERY}/${AGENT_DEF_DIR}/\${AGENT}.md" \\
  --in-session session.json \\
  --out-session session.json \\
  --template "${MACHINERY}/${PROMPT_TEMPLATE}" \\
  --skills-dir "${MACHINERY}/${SKILLS_DIR}" \\
  --max-iterations "${cfgStep.outputs.max_iterations}" \\
  --credentials-file "${CREDENTIALS_FILE}" \\
  \${TOOLS_ARG} \\
  > atoma_output.txt 2> atoma_logs.txt || EXIT_CODE=$?

echo "=== Atoma Logs ===" >&2
cat atoma_logs.txt >&2

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
  cat atoma_output.txt
  echo "\${RESULT_EOF}"
} >> "$GITHUB_OUTPUT"

${scriptCommandWithArgs(extractDirectiveRef, { "output-file": "atoma_output.txt", "def-dir": `${MACHINERY}/${AGENT_DEF_DIR}` })}

# Detect whether a tool call already triggered an automatic follow-up
# dispatch during this run (atoma__launch_sub_agent, github__create_pr ->
# reviewer, github__merge_pr -> orchestrator-or-re-invoked-agent), as
# opposed to the agent genuinely finishing with nothing further happening.
# Every dispatch site writes a structured \`{"op":"dispatch",...}\` entry to
# the ops log (see lib/ops-log.ts's logDispatch()) -- checking for that one
# stable, documented JSON field is far more robust than the previous
# approach (grepping atoma_logs.txt's raw stderr TEXT for hand-written
# strings like "dispatched: agent=..."), which silently broke once already
# when a refactor changed a log message's wording without updating the grep
# pattern to match.
CHAIN_CONTINUES=false
if [ -f atoma_ops.log ] && grep -q '"op":"dispatch"' atoma_ops.log; then
  CHAIN_CONTINUES=true
fi
echo "chain_continues=\${CHAIN_CONTINUES}" >> "$GITHUB_OUTPUT"
`,
  },
  ["result", "directive", "max_iterations_reached", "chain_continues"] as const,
);

const tokenUsageStep = new TypedOutputsStep({
  name: "Write token usage summary",
  if: "always() && hashFiles('atoma_logs.txt') != ''",
  shell: "bash",
  run: `USAGE_LINE=$(grep -m1 "ATOMA_TOKEN_USAGE:" atoma_logs.txt 2>/dev/null || true)
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
    session: "session.json",
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
    session: "session.json",
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
if [ -f atoma_logs.txt ]; then
  # Redacted before it becomes a comment. \`atoma_logs.txt\` holds every MCP
  # server's stderr, and \`unauthorized\` -- one of the words grepped for here --
  # is exactly the line a provider or a \`gh\` call emits WITH the credential in
  # it. GitHub masks registered secrets in the workflow log and does nothing for
  # an issue comment, so this excerpt would arrive in the clear.
  #
  # Shape patterns only: this step holds no credential values, and handing it
  # some so it could match them literally would put them in one more process's
  # environment to protect one comment. A failure to redact yields no excerpt
  # rather than a raw one.
  ERR_MSG=$(grep -iP 'error|fail|panic|exception|unauthorized' atoma_logs.txt | head -n 5 | ${scriptCommand(redactStreamRef)} || true)
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
    run: `${scriptCommandWithArgs(manageDispatchLoopRef, {
      session: "session.json",
      "new-event-count": buildContextStep.outputs.new_event_count,
      directive: runAgentStep.outputs.directive,
    })}\n`,
  },
  ["auto_dispatch_count", "loop_limit_reached"] as const,
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
  },
  run: `if [ -n "$NUMBER" ]; then
  MENTION=""
  if [ -n "$NOTIFY" ]; then
    MENTION="@\${NOTIFY} - "
  fi
  BD=$(mktemp)
  echo "\${MENTION}Auto-dispatch loop limit (${LOOP_LIMIT} consecutive runs) reached." > "$BD"
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
  // Every step in this job reads its scripts and this project's configuration
  // from here rather than from the checkout. See MACHINERY_DIR.
  env: { ATOMA_MACHINERY_ROOT: MACHINERY_DIR },
}).addSteps([
  // First, before the checkout: nothing should run at all on an input this job
  // is going to splice into shell text.
  validateInputsStep,
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
# started by name. This list is for libraries a tool server imports, and those
# have to be resolvable from the workspace — they are excluded from the bundle
# because they reach native code a JavaScript bundler cannot carry.
BUN_PKGS=$(jq -r '.bun[]? // empty' "$MCP_PKGS_FILE" 2>/dev/null || true)
if [ -n "$BUN_PKGS" ]; then
  echo "Installing bun MCP libraries: $BUN_PKGS"
  bun add --no-save $BUN_PKGS
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
  // Build the sandbox the `shell` tool server runs in. See #374, and
  // `prepare_shell_confinement.ts` for why this exists at all.
  //
  // AFTER environment setup on purpose: the overlay's lower layer is the host's
  // $HOME as it stands when the overlay is created, so anything setup installed
  // there -- a rustup toolchain, a pip --user package -- has to already be in
  // place. Creating the overlay first would hide it.
  //
  // Two things the container cannot arrange for itself, both needing the host:
  //
  //   The overlay. `mount -t overlay` needs privilege, and its directories must
  //   be owned by the runner rather than by root -- rootless podman maps host
  //   root outside its id range, where it appears as `nobody` and the container
  //   matches neither owner nor group.
  //
  //   The work tree's group bit. The container runs as a subordinate uid with the
  //   runner's primary GROUP, so it writes the tree through group permission.
  //   `setgid` on directories keeps that true for files created later, by either
  //   side. Measured at 9ms for 302 files.
  new TypedOutputsStep({
    name: "Confine the shell tool server",
    shell: "bash",
    run: `${scriptCommandWithArgs(prepareShellConfinementRef, { out: SHELL_SANDBOX_DIR })}
sudo mkdir -p ${SHELL_OVERLAY_ROOT}/upper ${SHELL_OVERLAY_ROOT}/work ${SHELL_OVERLAY_ROOT}/merged
sudo chown "$(id -un):$(id -gn)" ${SHELL_OVERLAY_ROOT} ${SHELL_OVERLAY_ROOT}/upper ${SHELL_OVERLAY_ROOT}/work ${SHELL_OVERLAY_ROOT}/merged
sudo mount -t overlay overlay \\
  -o lowerdir="$HOME",upperdir=${SHELL_OVERLAY_ROOT}/upper,workdir=${SHELL_OVERLAY_ROOT}/work \\
  ${SHELL_OVERLAY_ROOT}/merged
chmod g+w ${SHELL_OVERLAY_ROOT}/merged

# The tree the container shares with the host, reachable through the group it
# runs as. Failures are tolerated: a path the runner cannot chmod is one the
# container was never going to write either.
chmod -R g+w "$GITHUB_WORKSPACE" 2>/dev/null || true
find "$GITHUB_WORKSPACE" -type d -exec chmod g+s {} + 2>/dev/null || true

# podman's signature lookaside is hardcoded to $HOME/.local/share/containers/
# sigstore and does NOT consult XDG_DATA_HOME, so the XDG redirection tools.yaml
# does for config, storage and runtime state misses this one. Every nested
# "podman run" opens a path under it, and on the host that chain is owner-only, so
# the container -- a different uid, carrying only the host user's group -- got:
#   open /home/runner/.local/share/containers/sigstore/library/alpine@sha256=...:
#   permission denied
# Opening the chain to the group is a write to the overlay's UPPER layer, so the
# host's own $HOME keeps its modes. This chain only, not $HOME at large: chmod -R
# there would copy the entire home directory up into the overlay.
for dir in .local .local/share .local/share/containers .local/share/containers/sigstore; do
  mkdir -p "${SHELL_OVERLAY_ROOT}/merged/$dir"
  chmod g+rwxs "${SHELL_OVERLAY_ROOT}/merged/$dir"
done

# The two names a nested rootless runtime delegates its id mapping to, as ONE
# generated script under both -- and not setuid, which is the whole point.
#
# The container already holds CAP_SETUID and CAP_SETGID effectively: podman hands a
# non-root --user its added capabilities as AMBIENT ones. #426 measured that, and
# measured the two-line mapping podman wants succeeding when written by hand. What
# fails is the delegation, because executing a SETUID binary clears the ambient set
# and a setuid-root file confers nothing inside a non-initial user namespace -- so
# both the host's newuidmap and the owned copy v0.1.53 put here arrived as euid 0
# with no capability left to use:
#
#   newuidmap: write to uid_map failed: Operation not permitted
#
# A plain executable keeps the ambient set and writes the file itself. It grants
# nothing the calling process did not already have.
mkdir -p ${SHELL_OVERLAY_ROOT}/merged/.local/bin
for tool in newuidmap newgidmap; do
  install -m 0755 "${SHELL_SANDBOX_DIR}/newidmap" "${SHELL_OVERLAY_ROOT}/merged/.local/bin/$tool"
done

echo "confined shell: overlay at ${SHELL_OVERLAY_ROOT}/merged, mounts from ${SHELL_SANDBOX_DIR}"
`,
  }),
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
  installAtomaCliStep,
  // Immediately before the agent, because its output is what keys the secret
  // lookups in that step's own `env:`.
  toolSecretsStep,
  writeCredentialsStep,
  runAgentStep,
  tokenUsageStep,
  postResultCommentStep,
  recordRunMetadataStep,
  saveSessionStep,
  reportFailureStep,
  dirtyStep,
  new TypedOutputsStep({
    name: "Inject uncommitted changes into session",
    if: `${dirtyStep.rawOutputs.has_changes} == 'true'`,
    shell: "bash",
    run: `${scriptCommand(injectUncommittedNoticeRef)}\n`,
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
