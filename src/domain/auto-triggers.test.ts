import { describe, expect, test } from "bun:test";
import {
  resolveAutoTriggers,
  selectTriggerAgent,
  TRIGGER_CONDITIONS,
  type AutoTrigger,
  type TriggerContext,
} from "./auto-triggers.ts";

const ok = (raw: unknown): AutoTrigger[] => {
  const { triggers, problems } = resolveAutoTriggers(raw);
  expect(problems).toEqual([]);
  return triggers;
};

describe("resolveAutoTriggers", () => {
  test("an absent list is not a problem", () => {
    expect(resolveAutoTriggers(undefined)).toEqual({ triggers: [], problems: [] });
  });

  test("the shipped shape resolves", () => {
    const triggers = ok([
      { event: "pull_request.opened", agent: "reviewer" },
      { event: "pull_request_review.submitted", agent: "engineer", condition: "changes_requested" },
      { event: "issue_comment.created", agent: "$dispatch_agent", condition: "atoma:dispatch" },
    ]);
    expect(triggers).toHaveLength(3);
  });

  // The defect. An unrecognised condition was ignored, and because the matcher
  // asked "do I know a reason to skip this?" rather than "does this apply?",
  // ignoring it meant the trigger fired every time instead of never. The author
  // of the typo had every reason to believe the opposite.
  test("a misspelled condition is an error, not a trigger that always fires", () => {
    const { triggers, problems } = resolveAutoTriggers([
      { event: "pull_request.opened", agent: "reviewer", condition: "nondraft" },
    ]);
    expect(triggers).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nondraft");
    expect(problems[0]).toContain("non_draft");
  });

  // Same all-or-nothing rule the other resolvers use: a partly-honoured list
  // dispatches some agents and silently not others.
  test("one bad entry rejects the whole list", () => {
    const { triggers, problems } = resolveAutoTriggers([
      { event: "pull_request.opened", agent: "reviewer" },
      { event: "pull_request.closed", agent: "engineer", condition: "whenever" },
    ]);
    expect(triggers).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  test("a missing event or agent is reported", () => {
    expect(resolveAutoTriggers([{ agent: "reviewer" }]).problems[0]).toContain("`event`");
    expect(resolveAutoTriggers([{ event: "pull_request.opened" }]).problems[0]).toContain("`agent`");
  });

  test("an unknown key is reported rather than dropped", () => {
    const { problems } = resolveAutoTriggers([
      { event: "pull_request.opened", agent: "reviewer", conditon: "non_draft" },
    ]);
    expect(problems[0]).toContain("conditon");
  });

  test("a non-array is reported", () => {
    expect(resolveAutoTriggers({ event: "x" }).problems).toHaveLength(1);
  });
});

describe("selectTriggerAgent", () => {
  const triggers = ok([
    { event: "pull_request.opened", agent: "reviewer" },
    { event: "pull_request.synchronize", agent: "reviewer", condition: "non_draft" },
    { event: "pull_request_review.submitted", agent: "engineer", condition: "changes_requested" },
    { event: "issue_comment.created", agent: "$dispatch_agent", condition: "atoma:dispatch" },
  ]);

  test("an unconditional entry matches on the event alone", () => {
    expect(selectTriggerAgent(triggers, { event: "pull_request.opened" })).toBe("reviewer");
  });

  test("nothing matches an event nobody configured", () => {
    expect(selectTriggerAgent(triggers, { event: "issues.labeled" })).toBe("");
  });

  test("changes_requested narrows on the review state", () => {
    const event = "pull_request_review.submitted";
    expect(selectTriggerAgent(triggers, { event, reviewState: "changes_requested" })).toBe("engineer");
    expect(selectTriggerAgent(triggers, { event, reviewState: "approved" })).toBe("");
    expect(selectTriggerAgent(triggers, { event })).toBe("");
  });

  test("non_draft skips a draft and matches everything else", () => {
    const event = "pull_request.synchronize";
    expect(selectTriggerAgent(triggers, { event, isDraft: true })).toBe("");
    expect(selectTriggerAgent(triggers, { event, isDraft: false })).toBe("reviewer");
    // Unknown draft state is not a draft: the old script compared the raw string
    // to "true", so anything else -- including an unset variable -- passed.
    expect(selectTriggerAgent(triggers, { event })).toBe("reviewer");
  });

  // `atoma:dispatch` documents the delivery system's own comment marker, which
  // atoma-manual-comment.yml parses out of the body. It must never select an
  // agent here. It used to be passed over only because the shipped config pairs
  // it with a `$`-prefixed placeholder agent -- so the same condition beside a
  // real agent name would have dispatched on every comment.
  test("atoma:dispatch never selects an agent, whatever the agent is called", () => {
    expect(selectTriggerAgent(triggers, { event: "issue_comment.created" })).toBe("");
    const withRealAgent = ok([{ event: "issue_comment.created", agent: "engineer", condition: "atoma:dispatch" }]);
    expect(selectTriggerAgent(withRealAgent, { event: "issue_comment.created" })).toBe("");
  });

  test("a placeholder agent is never dispatched", () => {
    const placeholder = ok([{ event: "issues.opened", agent: "$something" }]);
    expect(selectTriggerAgent(placeholder, { event: "issues.opened" })).toBe("");
  });

  test("the first matching entry wins", () => {
    const two = ok([
      { event: "issues.opened", agent: "first" },
      { event: "issues.opened", agent: "second" },
    ]);
    expect(selectTriggerAgent(two, { event: "issues.opened" })).toBe("first");
  });
});

/**
 * Each condition's meaning lives in its own entry now, so this asserts the entry rather
 * than a copy of the rule: the tag and the matcher have to agree, which is what a
 * separate switch could not be made to guarantee.
 */
describe("TRIGGER_CONDITIONS", () => {
  const event = (extra: Partial<TriggerContext> = {}): TriggerContext => ({
    event: "pull_request.synchronize",
    ...extra,
  });

  test("every condition carries a matcher, and elsewhere means never here", () => {
    for (const [name, spec] of Object.entries(TRIGGER_CONDITIONS)) {
      expect(typeof spec.matches, name).toBe("function");
      if (spec.kind === "elsewhere") {
        expect(
          spec.matches(event()),
          `${name} is answered elsewhere and must never select an agent here`,
        ).toBe(false);
      }
    }
  });

  test("a runtime condition reads the event it is about", () => {
    const changesRequested = TRIGGER_CONDITIONS.changes_requested;
    const nonDraft = TRIGGER_CONDITIONS.non_draft;
    expect(changesRequested?.matches(event({ reviewState: "changes_requested" }))).toBe(true);
    expect(changesRequested?.matches(event({ reviewState: "approved" }))).toBe(false);
    expect(nonDraft?.matches(event({ isDraft: true }))).toBe(false);
    expect(nonDraft?.matches(event({ isDraft: false }))).toBe(true);
  });
});
