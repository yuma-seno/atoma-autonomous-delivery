import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HANDOFF_LIMIT,
  handoffLimitReached,
  handoffsSincePerson,
  resolveHandoffLimit,
  type ChainComment,
} from "./dispatch-chain.ts";
import { AGENT_TAG, CI_RETRY_TAG, LLM_CONTEXT_TAG } from "../lib/tags.ts";

/**
 * These replace `manage_dispatch_loop.test.ts`, which was green and testing
 * nothing.
 *
 * Three of its four cases passed `newEventCount = 0`, an input the workflow cannot
 * produce: the agent step only runs when `new_event_count != 0`, and when it does
 * not run the loop-control step is skipped with it. So the branch that advanced the
 * counter was covered and unreachable at once, and the limit never fired in a year
 * of runs.
 *
 * The lesson shapes these: every input here is a comment list of the shape
 * `repos/{repo}/issues/{n}/comments` actually returns, built from the real tag
 * writers rather than from hand-typed HTML comments. A case that cannot happen on
 * GitHub cannot be written without noticing.
 */
const person = (body = "looks good"): ChainComment => ({ authorType: "User", body });
const agent = (name = "engineer"): ChainComment => ({
  authorType: "Bot",
  body: `${AGENT_TAG.write(name)}\nDone. Handing off.`,
});
const ci = (attempt = 1): ChainComment => ({
  authorType: "Bot",
  body: `${CI_RETRY_TAG.write(attempt)}\nCI failed.`,
});
const operational = (): ChainComment => ({
  authorType: "Bot",
  body: `${LLM_CONTEXT_TAG.write("exclude")}\nLabel added.`,
});

const tally = (comments: ChainComment[]): number => handoffsSincePerson(comments, (body) => AGENT_TAG.has(body));

describe("counting agent handoffs since a person last spoke", () => {
  test("an empty issue has no handoffs", () => {
    expect(tally([])).toBe(0);
  });

  /**
   * The case the old counter got wrong. engineer hands to reviewer, reviewer hands
   * back, and so on -- each one posting a result comment. The old reset read every
   * one of those as "something new happened" and started over, so this sequence
   * counted 0 forever.
   */
  test("an engineer/reviewer ping-pong accumulates", () => {
    const chain = [person("/engineer"), agent("engineer"), agent("reviewer"), agent("engineer"), agent("reviewer")];
    expect(tally(chain)).toBe(4);
  });

  test("a person's comment ends the walk and is not counted", () => {
    const chain = [agent("engineer"), agent("reviewer"), person("hold on"), agent("engineer")];
    expect(tally(chain), "only the run after the person's comment").toBe(1);
  });

  /**
   * The whole point of counting rather than storing: the tally is a property of the
   * issue, so a re-dispatch, a new workflow run or a lost session changes nothing.
   */
  test("only the newest unbroken run of agent comments counts", () => {
    const chain = [agent(), agent(), agent(), agent(), agent(), agent(), person("try again"), agent(), agent()];
    expect(tally(chain)).toBe(2);
  });

  /**
   * A bot comment that is not an agent result -- a CI retry notice, a label
   * notification -- neither counts nor resets. It is noise in the middle of a
   * chain, and treating it as a person's intervention is exactly the mistake that
   * made the old limit unreachable.
   */
  test("other bot comments neither count nor reset", () => {
    const chain = [person("/engineer"), agent("engineer"), ci(1), operational(), agent("engineer")];
    expect(tally(chain)).toBe(2);
  });

  /**
   * Everything that is not `"User"` reads as not-a-person, and the direction is
   * deliberate: a bot read as a person resets the tally and hides a runaway chain,
   * while a person read as a bot escalates early. Uncertainty goes to the side that
   * interrupts.
   */
  test("only user.type User counts as a person", () => {
    for (const authorType of ["Bot", "Organization", "Mannequin", "", undefined]) {
      const chain: ChainComment[] = [{ authorType, body: "something" }, agent(), agent()];
      expect(tally(chain), `authorType=${String(authorType)}`).toBe(2);
    }
    expect(tally([{ authorType: "User", body: "something" }, agent(), agent()])).toBe(2);
    expect(tally([agent(), { authorType: "User", body: "wait" }, agent()])).toBe(1);
  });

  /**
   * An agent comment carrying no tag cannot be told from anything else, so it does
   * not count. Erring low rather than high, the same direction as a failed read:
   * this bounds wasted model runs, and refusing to hand off on a doubtful reading
   * would stop work that is going fine.
   */
  test("an untagged bot comment does not count", () => {
    expect(tally([{ authorType: "Bot", body: "no tag here" }, agent()])).toBe(1);
  });

  test("a missing body is not an agent comment", () => {
    expect(tally([{ authorType: "Bot" }, agent()])).toBe(1);
  });
});

describe("when the chain has to stop", () => {
  test("the limit is inclusive: the handoff that would exceed it is the one refused", () => {
    expect(handoffLimitReached(4, 5)).toBe(false);
    expect(handoffLimitReached(5, 5)).toBe(true);
    expect(handoffLimitReached(6, 5)).toBe(true);
  });
});

describe("resolving the configured limit", () => {
  test("a usable value is taken", () => {
    expect(resolveHandoffLimit(12)).toBe(12);
    expect(resolveHandoffLimit("12"), "config.json read as unknown").toBe(12);
    expect(resolveHandoffLimit(7.9), "floored rather than refused").toBe(7);
  });

  /**
   * Same rule as every other limit here, and as `infra::timeouts` in atoma: zero
   * and nonsense mean the default. A repository that wants no automatic handoffs
   * turns `auto_triggers` off, which says so; `0` here would be a silent
   * "nothing may ever hand off" hidden in a number.
   */
  test("nothing usable means the default", () => {
    for (const raw of [undefined, null, 0, -3, "", "  ", "abc", NaN, Infinity, {}, []]) {
      expect(resolveHandoffLimit(raw), JSON.stringify(raw) ?? String(raw)).toBe(DEFAULT_HANDOFF_LIMIT);
    }
  });
});
