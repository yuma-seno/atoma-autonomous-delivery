/**
 * control-commands.ts — the slash commands that act on a run instead of starting one.
 *
 * ## Why they share the agent syntax
 *
 * `/stop` and `/resume` look exactly like `/engineer`, and that is deliberate: a
 * person typing into a GitHub comment should not have to remember two syntaxes for
 * "tell Atoma to do something". The cost is that they occupy names in the agent
 * namespace, which is what this module is for.
 *
 * `parse_comment_command.ts` checks this list before it reads a name as an agent, so
 * `/stop` can never dispatch a run looking for `stop.md`. `deliverable-integrity.ts`
 * refuses an agent definition named after one of these, so the shadowing cannot
 * arrive from the other side either. Two rules, one list, defined here.
 *
 * ## What they mean
 *
 * `/stop` asks the run currently executing on this issue/PR to stop at its next turn
 * and save its session. It is not a cancel: a cancelled job never reaches the step
 * that writes the session, so cancelling would silently mean discarding.
 *
 * `/resume` starts the same agent again on the saved session, carrying no
 * instruction. That is the whole difference from `/<agent>`, which also resumes the
 * session but lets the person put an instruction on the following lines — which is
 * why `/resume` deliberately refuses one rather than accepting and ignoring it.
 *
 * Neither is a state. A stopped run has ended and handed back to a person, which is
 * the same terminal state as an agent that finished its turn, ran out of time, or
 * hit the handoff limit — `shouldReleaseGuard` already treats all of those alike, and
 * a stop joins them rather than adding a fourth. This is why there is no `paused`
 * label: "nothing is executing here" is already said by the in-progress label being
 * gone.
 */

/** Every control command, as it is typed after the slash. */
export const CONTROL_COMMAND_NAMES = ["stop", "resume"] as const;

export type ControlCommand = (typeof CONTROL_COMMAND_NAMES)[number] | "";

/** Whether `name` is a control command rather than an agent name. */
export function isControlCommand(name: string): name is (typeof CONTROL_COMMAND_NAMES)[number] {
  return (CONTROL_COMMAND_NAMES as readonly string[]).includes(name);
}
