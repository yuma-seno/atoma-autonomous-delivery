#!/usr/bin/env bun
/**
 * post_result_comment.ts — Post the agent's final output as a GitHub
 * comment, including token usage and (when nothing further will
 * happen automatically) a mention.
 *
 * Reads atoma_output.txt (required) and atoma_logs.txt (optional, for the
 * ATOMA_TOKEN_USAGE: line) from the current directory.
 *
 * Usage:
 *   post_result_comment.ts --number N --agent NAME [--notify LOGIN]
 *     [--directive NAME] [--chain-continues true|false]
 *     [--max-iterations-reached true|false] --run-url URL
 * Writes `comment_id=<id>` to $GITHUB_OUTPUT.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { AGENT_TAG, CHANGED_TAG, PARENT_TAG } from "../lib/tags.ts";
import { shouldMentionOnCompletion } from "../domain/completion-mention.ts";
import { redact } from "../domain/redaction.ts";
import { escapedMentionNotice, escapeUnknownMentions } from "../domain/mention.ts";
import { knownParticipants } from "../lib/participants.ts";
import type { Session } from "../lib/session.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface PostResultCommentArgs {
  number: string | number;
  agent: string;
  type?: string;
  notify?: string;
  directive?: string;
  "chain-continues"?: string;
  "max-iterations-reached"?: string;
  /** "true" when this run pushed a commit, opened a pull request, or merged one. */
  changed?: string;
  /**
   * The session, read only to salvage something when the run ran out of iterations.
   *
   * Optional: a run that ends normally never opens it.
   */
  session?: string;
  "run-url": string;
  /**
   * The agent's stdout, and the log it wrote alongside.
   *
   * Arguments rather than the bare names this used to open. Those were relative
   * paths, correct only while the run's files sat in the repository root -- #487
   * moved them to `$RUNNER_TEMP/atoma-run` and every result comment since was
   * silently dropped, because `existsSync("atoma_output.txt")` was false and the
   * skip branch reads exactly like a session that ended via a tool call.
   *
   * Two full releases went out that way. The step reported success, the agent wrote
   * its report -- 3,914 characters in the run that found this -- and nobody received
   * it.
   */
  output: string;
  "logs-file": string;
}

export const ref = defineScript<PostResultCommentArgs>(import.meta.url);

/**
 * The token counts the run reported, and deliberately no money.
 *
 * This used to multiply the counts by a hardcoded `0.15 / 0.6` per million and
 * print an `Estimated cost`. That number could not be right, for three reasons
 * at once, pulling in different directions:
 *
 *   1. The rate was one model's, applied to every model. It matched no model
 *      any agent here runs — the three agents are on three different ones.
 *   2. `prompt` is not the input total. Providers report the tokens that missed
 *      the cache, so a cached prefix is absent from the number entirely.
 *   3. Whatever `prompt` did contain was charged at the full uncached rate,
 *      though most of it is cache reads at a fraction of that.
 *
 * The errors did not even share a sign, so the printed figure could not be
 * called high or low — only meaningless. A confident wrong number is worse than
 * no number, so it is gone.
 *
 * Getting it right needs one of two things, and neither is wanted here. A price
 * table is configuration that silently goes stale and then produces confident
 * wrong numbers again — the state this is leaving. Reading the real charge from
 * the provider works, but only one of the four providers Atoma supports reports
 * one at all: OpenRouter returns `usage.cost`, while OpenAI and Anthropic report
 * tokens only, and GitHub Copilot bills per request rather than per token, so
 * the figure does not exist there even in principle.
 *
 * So: tokens, which every provider reports and which are a measurement rather
 * than a derivation. Add money here only when it arrives from the provider as
 * money.
 */
function tokenUsageLines(logsFile: string): string[] {
  if (!existsSync(logsFile)) return [];
  const usageLine = readFileSync(logsFile, "utf8")
    .split("\n")
    .find((l) => l.includes("ATOMA_TOKEN_USAGE:"));
  if (!usageLine) return [];

  const prompt = /prompt=(\d+)/.exec(usageLine)?.[1];
  const completion = /completion=(\d+)/.exec(usageLine)?.[1];
  const total = /total=(\d+)/.exec(usageLine)?.[1];

  return ["", "---", `_Tokens: ${total ?? "?"} total (${prompt ?? "?"} prompt + ${completion ?? "?"} completion)_`];
}

/**
 * Whether this issue is an agent-created sub-task, and whether it is closed.
 *
 * Both answers come from one read, and a failed read answers "no" — a run
 * mentioning a person it need not have is a smaller harm than a run that
 * silently drops the only signal that work has stopped.
 *
 * Skipped entirely for a pull request run: `--number` is a PR number there, and
 * `gh issue view` on one is an error rather than an answer.
 */
function subIssueState(number: string, type?: string): { isSubIssue: boolean; issueClosed: boolean } {
  if (type !== "issue") return { isSubIssue: false, issueClosed: false };
  const { code, stdout } = gh(
    "issue", "view", number, "--repo", process.env.GITHUB_REPOSITORY ?? "", "--json", "state,body",
  );
  if (code !== 0) return { isSubIssue: false, issueClosed: false };
  try {
    const issue = JSON.parse(stdout) as { state?: string; body?: string };
    return {
      isSubIssue: PARENT_TAG.read(issue.body ?? "") !== undefined,
      issueClosed: issue.state === "CLOSED",
    };
  } catch {
    return { isSubIssue: false, issueClosed: false };
  }
}

/**
 * The last thing the agent actually said, out of the session.
 *
 * For the iteration-limit case only. Walks backwards for an assistant message with
 * text: the last few turns of a run that ran out are usually tool calls with no
 * words, which is why the output file was empty in the first place.
 *
 * `undefined` when there is nothing to salvage, which is a real outcome -- a run
 * that made 324 tool calls and never wrote a sentence has nothing to report, and
 * saying so is better than posting an empty comment.
 */
export function lastAgentText(sessionPath: string | undefined): string | undefined {
  if (!sessionPath || !existsSync(sessionPath)) return undefined;
  let session: Session;
  try {
    session = JSON.parse(readFileSync(sessionPath, "utf8")) as Session;
  } catch {
    return undefined;
  }
  const messages = session.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim() !== "") return content;
  }
  return undefined;
}

export function buildCommentBody(args: {
  agent: string;
  notify?: string;
  directive?: string;
  chainContinues?: string;
  maxIterationsReached?: string;
  runUrl: string;
  output: string;
  usageLines: string[];
  isSubIssue?: boolean;
  issueClosed?: boolean;
  /** Logins the agent wrote as mentions that were escaped instead. */
  escapedMentions?: readonly string[];
  /**
   * Whether `output` is the agent's last message rather than its report.
   *
   * Said in the comment, because presenting a sentence from the middle of the work
   * as a conclusion is worse than posting nothing: a reader would act on it.
   */
  salvaged?: boolean;
  /**
   * Whether this run pushed a commit, opened a pull request or merged one.
   *
   * Written into the comment because that is where the next run can read it.
   * `domain/progress.ts` counts consecutive runs that changed nothing, and it
   * counts them from the thread rather than from a counter -- so the thread has to
   * carry the fact.
   */
  changed?: boolean;
}): string {
  const lines = [
    AGENT_TAG.write(args.agent),
    CHANGED_TAG.write(args.changed === true ? "yes" : "no"),
  ];
  if (args.salvaged === true) {
    lines.push(
      "> [!WARNING]",
      "> This run hit its iteration limit and never wrote a report. Below is the last thing it said,",
      "> from the middle of the work — not a conclusion, and not a summary of what it found.",
      "",
    );
  }
  lines.push(args.output, "", ...args.usageLines);

  // Directly under what the agent wrote, because that is what it is about, and
  // above the run footer, which nobody reads for this.
  const escapedNotice = escapedMentionNotice(args.escapedMentions ?? []);
  if (escapedNotice !== undefined) lines.push("", escapedNotice, "");

  if (
    shouldMentionOnCompletion({
      directive: args.directive,
      chainContinues: args.chainContinues === "true",
      notify: args.notify,
      isSubIssue: args.isSubIssue ?? false,
      issueClosed: args.issueClosed ?? false,
    })
  ) {
    lines.push(
      `@${args.notify} — **${args.agent}** task completed. No agent will be automatically executed next. Please review the results or provide instructions for the next step.`,
      "",
    );
  }

  lines.push("---", `_run by [${args.agent}](${args.runUrl})_`);
  if (args.maxIterationsReached === "true") {
    lines.push(`⚠️ _Max iterations reached. Comment \`/${args.agent}\` to continue._`);
  }

  return lines.join("\n");
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      type: { type: "string" },
      notify: { type: "string" },
      directive: { type: "string" },
      "chain-continues": { type: "string" },
      "max-iterations-reached": { type: "string" },
      "run-url": { type: "string" },
      changed: { type: "string" },
      session: { type: "string" },
      output: { type: "string" },
      "logs-file": { type: "string" },
    },
  });

  if (!values.number || !values.agent || !values["run-url"]) {
    console.error("usage: post_result_comment.ts --number N --agent NAME --run-url URL [...]");
    process.exit(2);
  }

  // Redacted on the way out, by shape only.
  //
  // GitHub Actions masks registered secrets in the workflow LOG and does nothing
  // for an issue comment, and this comment is the agent's own text -- whatever it
  // saw and chose to repeat. `redact()` with no literals applies the credential
  // shape patterns, which needs no knowledge of any particular value and so works
  // in this step, which deliberately holds none.
  //
  // A net, not a control: see domain/redaction.ts on what a shape check cannot
  // catch. The reason it is here at all is that this is one of the two sinks that
  // publish unmasked text (the other is the failure excerpt in
  // atoma-runner.wac.ts).
  // Required, not defaulted. A default would put the old relative path back and
  // restore the exact silence this is fixing: a caller that forgot the argument
  // would look in the work tree, find nothing, and report a session that ended via
  // a tool call.
  const outputFile = values.output;
  if (!outputFile) {
    console.error("post_result_comment.ts: --output is required (the agent's stdout file)");
    process.exit(2);
  }
  const redacted = redact(existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "");

  // `atoma_output.txt` is empty whenever the run ended via a session-ending
  // tool call (launch_sub_agent, request_close_issue, create_pr -- see
  // src/atoma/tools/scripts/mcp/{atoma,github}.ts's `_meta.session_ends`):
  // atoma's own inference loop stops immediately in that case, before the
  // model ever gets a further turn to produce text. Each of those tools
  // already posts its OWN dedicated, meaningful comment (e.g. "Launched
  // sub-agent(s): ...", "PR #N created..."), so posting a second, essentially
  // content-free "run by [agent](url)" comment here on top of that would
  // just be noise -- skip entirely rather than post an empty wrapper.
  // Empty output has two meanings, and they need opposite treatment.
  //
  // A session-ending tool call leaves it empty because atoma's loop stops the moment
  // that tool returns, before the model gets another turn -- and each of those tools
  // posts its own comment, so a second content-free one would be noise. That is the
  // skip below, and it is right.
  //
  // Running out of iterations leaves it empty too, and there nothing else speaks.
  // Measured (#544): a run spent 17 minutes and 154k tokens, and the thread received
  // one notice saying the limit was reached. What it had worked out was in the
  // session and nowhere a person would look.
  let output = redacted;
  let salvaged = false;
  if (!output.trim() && values["max-iterations-reached"] === "true") {
    const last = lastAgentText(values.session);
    if (last !== undefined) {
      output = redact(last);
      salvaged = true;
      console.error("salvaged the agent's last message from the session (iteration limit)");
    }
  }

  if (!output.trim()) {
    console.error("atoma_output.txt is empty (session ended via a tool call) -- skipping result comment.");
    return;
  }

  // Checked on the way out for the same reason it is redacted on the way out:
  // this text is whatever the agent decided to write, and a comment is the one
  // place it reaches people. A `@name` here notifies a real account -- see
  // `domain/mention.ts` for why a name it read somewhere is enough.
  //
  // The mention the RUNNER adds is not part of this. It is put in by
  // `buildCommentBody` below from a login `resolveNotify` produced, and never
  // passes through here.
  const checked = escapeUnknownMentions(
    output,
    knownParticipants(process.env.GITHUB_REPOSITORY ?? "", values.number),
  );
  if (checked.escaped.length > 0) {
    console.error(`escaped ${checked.escaped.length} unconfirmed mention(s): ${checked.escaped.join(", ")}`);
  }

  const body = buildCommentBody({
    agent: values.agent,
    salvaged,
    notify: values.notify,
    directive: values.directive,
    chainContinues: values["chain-continues"],
    maxIterationsReached: values["max-iterations-reached"],
    runUrl: values["run-url"],
    output: checked.text,
    escapedMentions: checked.escaped,
    changed: values.changed === "true",
    usageLines: tokenUsageLines(values["logs-file"] ?? ""),
    ...subIssueState(values.number, values.type),
  });

  const { code, stdout, stderr } = gh(
    "api",
    `repos/${process.env.GITHUB_REPOSITORY}/issues/${values.number}/comments`,
    "--method",
    "POST",
    "-f",
    `body=${body}`,
    "--jq",
    ".id",
  );
  if (code !== 0) {
    throw new Error(`Failed to post result comment: ${stderr || stdout}`);
  }

  const commentId = stdout.trim();
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `comment_id=${commentId}\n`);
  console.error(`Posted comment ID: ${commentId}`);
}

if (import.meta.main) main();
