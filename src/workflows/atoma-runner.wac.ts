import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import type { GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedOutputsStep, type DefinedJob } from "./actions/base.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { defineCallableWorkflow } from "./actions/reusable-workflow.ts";
import { scriptCommand, scriptCommandWithArgs } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { ref as resolveNotifyRef } from "../scripts/resolve_notify.ts";
import { buildArgv as configValueArgv, ref as getConfigValueRef } from "../scripts/get_config_value.ts";
import { ref as manageInProgressLabelRef } from "../scripts/manage_in_progress_label.ts";
import { ref as notifyMaxIterationsRef } from "../scripts/notify_max_iterations.ts";
import { ref as runEnvironmentSetupRef } from "../scripts/run_environment_setup.ts";
import { ref as injectUncommittedNoticeRef } from "../scripts/inject_uncommitted_notice.ts";
import { ref as fetchEventsRef } from "../scripts/fetch_events.ts";
import { ref as restoreAgentSessionRef } from "../scripts/restore_agent_session.ts";
import { ref as reconcileGithubSessionRef } from "../scripts/reconcile_github_session.ts";
import { ref as extractDirectiveRef } from "../scripts/extract_directive.ts";
import { ref as postResultCommentRef } from "../scripts/post_result_comment.ts";
import { ref as recordRunMetadataRef } from "../scripts/record_run_metadata.ts";
import { ref as saveAgentSessionRef } from "../scripts/save_agent_session.ts";
import { ref as manageDispatchLoopRef } from "../scripts/manage_dispatch_loop.ts";
import { ref as decideGuardReleaseRef } from "../scripts/decide_guard_release.ts";
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
//   5. add atoma/in-progress label, then RUN THE AGENT
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
const ATOMA_DEFAULT_VERSION = "v0.1.7";
const ATOMA_VERSION_DESC = "Atoma CLI version tag to install (e.g. v0.1.7). Use `source` to build from a checkout of yuma-seno/atoma@main.";

// Deployed-repo-relative paths into the `.github/atoma/` content tree (see
// src/atoma/ -- config.json, agent-definitions/, tools/tools.yaml).
// Referenced from three separate steps below (prepare/run/dispatch-next);
// centralized here so they can't drift from each other by typo.
const ORCHESTRATION_FILE = ".github/atoma/config.json";
const AGENT_DEF_DIR = ".github/atoma/agent-definitions";
const PROMPT_TEMPLATE = ".github/atoma/prompt-template.md";
const SKILLS_DIR = ".github/atoma/skills";
const TOOLS_FILE = ".github/atoma/tools/tools.yaml";

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
    run: `${scriptCommandWithArgs(reconcileGithubSessionRef, {
      events: "events.json",
      "agent-name": "${{ inputs.agent }}",
      config: ORCHESTRATION_FILE,
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

const runAgentStep = new TypedOutputsStep(
  {
    name: "Run agent",
    id: "atoma",
    if: `${buildContextStep.rawOutputs.new_event_count} != '0'`,
    env: {
      GH_TOKEN: "${{ github.token }}",
      GITHUB_PERSONAL_ACCESS_TOKEN: "${{ github.token }}",
      GITHUB_RUN_ID: "${{ github.run_id }}",
      ISSUE_NUMBER: fetchEventsStep.outputs.resolved_number,
      ISSUE_NOTIFY: notifyStep.outputs.notify,
      // Structured JSON-lines log every MCP tool mutation/dispatch decision
      // is written to (see lib/ops-log.ts) -- read back below to determine
      // chain_continues, and generally useful as a per-run audit trail.
      ATOMA_OPS_LOG: "atoma_ops.log",
    },
    shell: "bash",
    run: `AGENT="\${{ inputs.agent }}"
# Exported (not just a local shell var) so MCP tool-server subprocesses
# spawned by \`atoma run\` below can read the current agent's name, e.g. to
# tag artifacts they create (PRs, issues) with their origin agent.
export AGENT

TOOLS_ARG=""
if [ -f "${TOOLS_FILE}" ]; then
  TOOLS_ARG="--tools-file ${TOOLS_FILE}"
fi

if [ -n "\${{ secrets.OPENAI_API_KEY }}" ]; then
  export OPENAI_API_KEY="\${{ secrets.OPENAI_API_KEY }}"
fi
if [ -n "\${{ vars.OPENAI_BASE_URL }}" ]; then
  export OPENAI_BASE_URL="\${{ vars.OPENAI_BASE_URL }}"
fi
# Optional: Anthropic API key (only export when non-empty to avoid breaking auto-detection)
if [ -n "\${{ secrets.ANTHROPIC_API_KEY }}" ]; then
  export ANTHROPIC_API_KEY="\${{ secrets.ANTHROPIC_API_KEY }}"
fi
# Optional: force a specific provider (only export when non-empty)
if [ -n "\${{ vars.ATOMA_PROVIDER }}" ]; then
  export ATOMA_PROVIDER="\${{ vars.ATOMA_PROVIDER }}"
fi

# No --prompt-file or stdin is needed: the cached session contains both stable
# GitHub context and the agent's chronological working history.
EXIT_CODE=0
atoma run \\
  --agent-def "${AGENT_DEF_DIR}/\${AGENT}.md" \\
  --in-session session.json \\
  --out-session session.json \\
  --template "${PROMPT_TEMPLATE}" \\
  --skills-dir "${SKILLS_DIR}" \\
  --max-iterations ${cfgStep.outputs.max_iterations} \\
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

${scriptCommandWithArgs(extractDirectiveRef, { "output-file": "atoma_output.txt", "def-dir": AGENT_DEF_DIR })}

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
PROMPT=$(echo "$USAGE_LINE"     | grep -oP 'prompt=\\K[0-9]+')
COMPLETION=$(echo "$USAGE_LINE" | grep -oP 'completion=\\K[0-9]+')
TOTAL=$(echo "$USAGE_LINE"      | grep -oP 'total=\\K[0-9]+')
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
    if: `steps.atoma.outcome == 'success' && ${buildContextStep.rawOutputs.new_event_count} != '0'`,
    shell: "bash",
    env: { GH_TOKEN: "${{ github.token }}" },
    run: `${scriptCommandWithArgs(postResultCommentRef, {
      number: "${{ inputs.number }}",
      agent: "${{ inputs.agent }}",
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
  if: `steps.atoma.outcome == 'success' && ${postResultCommentStep.rawOutputs.comment_id} != ''`,
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
  if: "steps.atoma.outcome == 'success'",
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
  ERR_MSG=$(grep -iP 'error|fail|panic|exception|unauthorized' atoma_logs.txt | head -n 5 || true)
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
    if: "steps.atoma.outcome == 'success'",
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
    if: "steps.atoma.outcome == 'success'",
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
      outcome: "\${{ steps.atoma.outcome }}",
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
  `steps.atoma.outcome == 'success' && ${runAgentStep.rawOutputs.directive} != '' && ` +
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
  run: `if ! [[ "$DIRECTIVE" =~ ^[a-z][a-z0-9-]*$ ]]; then
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
  echo "\${MENTION}Auto-dispatch loop limit (5 consecutive runs) reached." > "$BD"
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
}).addSteps([
  new ActionsCheckoutV4({
    name: "Checkout repository",
    with: {
      ref: "${{ inputs.type == 'pr' && format('refs/pull/{0}/head', inputs.number) || '' }}",
    },
  }),
  new TypedOutputsStep({
    name: "Create feature branch for issue",
    if: "inputs.type == 'issue'",
    shell: "bash",
    run: `BRANCH="atoma/issue-\${{ inputs.number }}"
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null; then
  git fetch origin "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  git checkout -B "$BRANCH" "refs/remotes/origin/$BRANCH"
else
  STATUS=$?
  if [[ "$STATUS" -ne 2 ]]; then
    echo "Failed to inspect remote branch $BRANCH" >&2
    exit "$STATUS"
  fi
  git checkout -b "$BRANCH"
fi
echo "BRANCH=$BRANCH" >> $GITHUB_ENV
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
  // No separate "install MCP server dependencies" step needed: build-dist.ts
  // bundles every script (via Bun.build) with all its imports -- including
  // npm dependencies like @modelcontextprotocol/sdk/shell-quote -- inlined
  // into a single self-contained file, so the deployed `.github/atoma/tools/scripts/**`
  // needs no package.json/node_modules/bun install at all.
  new TypedOutputsStep({
    name: "Run configured environment setup",
    shell: "bash",
    run: `${scriptCommand(runEnvironmentSetupRef)}\n`,
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
