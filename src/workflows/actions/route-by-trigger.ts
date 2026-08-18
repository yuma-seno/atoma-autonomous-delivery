/**
 * route-by-trigger.ts — the three steps that turn a GitHub event into "this
 * agent, on this number, notifying this person", shared by the two workflows
 * that do it.
 *
 * `atoma-auto-trigger` (pull_request_target) and `atoma-pr-review`
 * (pull_request_review) are two workflows only because GitHub refuses to put
 * those two events on one: `pull_request_target` and `pull_request_review`
 * cannot be combined. Everything after the event is the same work, and it was
 * written out twice — three steps, the same three `run:` bodies, differing only
 * in which payload field each expression reads.
 *
 * That is why this exists rather than being tidiness. The bug fixed below —
 * a failed `match_trigger.ts` being read as "no trigger matched" — was written
 * twice too, and a fix applied to one copy would have left the other.
 *
 * The event-typed expressions stay at the call site. Each workflow knows its own
 * payload type and passes already-resolved strings, so `githubEvent<TEvent>` is
 * still checked against the events that workflow actually declares — which is
 * the whole value of those helpers, and would be lost by making this generic
 * over an event union no single workflow has.
 */
import { TypedOutputsStep } from "./base.ts";
import { scriptCommand } from "./script-call.ts";
import { ref as extractNotifyTagRef } from "../../scripts/extract_notify_tag.ts";
import { ref as matchTriggerRef, type MatchTriggerEnv } from "../../scripts/match_trigger.ts";

export interface TriggerRouteSpec {
  /** The pull request number, as an expression that resolves at run time. */
  prNumber: string;
  /** The pull request body, read for its `atoma:notify` tag. */
  prBody: string;
  /**
   * What this event tells `match_trigger.ts`.
   *
   * Typed as the script's own env contract, so a workflow cannot invent a
   * variable the script does not read, or misspell one it does.
   */
  matchEnv: MatchTriggerEnv;
}

/** The three steps, and the job `outputs:` map that exposes what they found. */
export interface TriggerRoute {
  steps: TypedOutputsStep<string>[];
  outputs: { agent: string; number: string; type: string; notify: string };
}

/**
 * Why the match step no longer hides its own failure.
 *
 * It used to run `AGENT=$(match_trigger.ts 2>/dev/null || true)`. Both halves of
 * that were wrong, and together they made a broken repository look like an idle
 * one.
 *
 * `|| true` masked nothing worth masking: the script already exits 0 and prints
 * nothing when no trigger matches, which is the ordinary case. The only thing it
 * suppressed was a genuine crash — and `match_trigger.ts` calls `loadConfig()`,
 * which throws on a `config.json` that is missing or will not parse. So one
 * trailing comma in that file stopped every pull-request auto-trigger in the
 * repository: the step went green, `agent` came out empty, the runner job was
 * skipped by its `if:`, and `2>/dev/null` had thrown away the parse error that
 * would have explained it.
 *
 * "Nothing matched" and "could not tell" are different answers and now produce
 * different outcomes: the first is silent and green, the second fails the step
 * with the script's own message on the log.
 */
function matchAgentRun(): string {
  return `if ! AGENT=$(${scriptCommand(matchTriggerRef)}); then
  echo "::error::match_trigger.ts failed, so no auto-trigger could be evaluated for this event. See the error above; a config.json that is missing or will not parse is the usual cause."
  exit 1
fi
`;
}

/**
 * Build the route: read the number, resolve the notify login, match the agent.
 *
 * The steps are returned in the order they must run — `match` reads `context`'s
 * outputs — and the `outputs` map is built from the same step objects, so a
 * renamed step id or output cannot leave the job exposing an expression that
 * resolves to nothing.
 */
export function routeByTriggerMatch(spec: TriggerRouteSpec): TriggerRoute {
  const contextStep = new TypedOutputsStep(
    {
      name: "Determine PR number from event context",
      id: "context",
      shell: "bash",
      // Both callers are pull-request events, so `pull_request` is always
      // present on the payload and there is no issue-only branch to handle.
      // Typing these against the real payload types is what showed the old
      // if/else's `else` branch to be dead.
      run: `echo "number=${spec.prNumber}" >> "$GITHUB_OUTPUT"
echo "type=pr" >> "$GITHUB_OUTPUT"
`,
    },
    ["number", "type"] as const,
  );

  const notifyStep = new TypedOutputsStep(
    {
      name: "Resolve notify login from PR body tag",
      id: "notify",
      shell: "bash",
      env: { PR_BODY: spec.prBody },
      run: `${scriptCommand(extractNotifyTagRef)}\n`,
    },
    ["notify"] as const,
  );

  const matchStep = new TypedOutputsStep(
    {
      name: "Match event to agent from config.json",
      id: "match",
      shell: "bash",
      env: spec.matchEnv as Record<string, string>,
      run: `${matchAgentRun()}if [ -n "\${AGENT}" ]; then
  echo "Matched agent: \${AGENT}"
  echo "agent=\${AGENT}" >> "$GITHUB_OUTPUT"
  echo "number=${contextStep.outputs.number}" >> "$GITHUB_OUTPUT"
  echo "type=${contextStep.outputs.type}" >> "$GITHUB_OUTPUT"
else
  echo "No auto_triggers entry matches this event; nothing to dispatch."
fi
`,
    },
    ["agent", "number", "type"] as const,
  );

  return {
    steps: [contextStep, notifyStep, matchStep],
    outputs: {
      agent: matchStep.outputs.agent,
      number: matchStep.outputs.number,
      type: matchStep.outputs.type,
      notify: notifyStep.outputs.notify,
    },
  };
}
