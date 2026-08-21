import { describe, expect, test } from "bun:test";
import { WORKSPACE_PATH, WORKSPACE_SENTENCE, workspaceScope } from "./workspace.ts";

describe("which issue's workspace a run shares", () => {
  test("a root issue owns its own", () => {
    expect(workspaceScope(461, [])).toEqual({ rootIssue: "461", resolved: true, why: "" });
  });

  test("a sub-issue shares the root's", () => {
    expect(workspaceScope(470, [461]).rootIssue).toBe("461");
  });

  test("the top of a longer chain wins, not the first hop", () => {
    expect(workspaceScope(472, [470, 465, 461]).rootIssue).toBe("461");
  });

  /**
   * A pull request shares its issue's workspace. An agent starts on the issue and
   * continues on the pull request, so a workspace tied to the GitHub object would
   * vanish at the handover -- taking with it the notes the continuation needs. What
   * it is tied to is the work.
   */
  test("a pull request shares the issue it belongs to", () => {
    expect(workspaceScope("487", [461]).rootIssue).toBe("461");
  });

  /**
   * The asymmetry that decides the fallback. Sharing what should have been separate
   * puts an unrelated issue's files in front of an agent, which has no way to
   * recognise them as foreign. Separating what should have been shared costs a child
   * the parent's notes -- visible, and workable around.
   */
  test("an unreadable parent chain means a private workspace, not a borrowed one", () => {
    const scope = workspaceScope(470, [], "GraphQL returned 502");
    expect(scope.rootIssue, "its own number").toBe("470");
    expect(scope.resolved).toBe(false);
    expect(scope.why).toBe("GraphQL returned 502");
  });

  test("a root issue and an unreadable chain are told apart", () => {
    expect(workspaceScope(461, []).resolved, "read, and there is no parent").toBe(true);
    expect(workspaceScope(461, [], "could not ask").resolved, "not read").toBe(false);
  });
});

describe("what the agent is told", () => {
  /**
   * A literal path, spelled out. An environment variable would make
   * `ls $ATOMA_WORKSPACE` return nothing when the expansion failed -- which reads
   * exactly like an empty directory, so "unset" and "empty" become
   * indistinguishable. That is a hallucination waiting to be reported as fact.
   */
  test("the path is absolute and appears verbatim in the sentence", () => {
    expect(WORKSPACE_PATH.startsWith("/")).toBe(true);
    expect(WORKSPACE_PATH).not.toContain("$");
    expect(WORKSPACE_SENTENCE).toContain(WORKSPACE_PATH);
    expect(WORKSPACE_SENTENCE, "no expansion for the agent to get wrong").not.toContain("${");
  });

  /**
   * Both halves have to be there. "This survives" alone invites leaving working
   * files in the repository as well; "nothing else survives" alone does not say
   * where to put them.
   */
  test("the sentence says both what survives and what does not", () => {
    expect(WORKSPACE_SENTENCE).toMatch(/survives/);
    expect(WORKSPACE_SENTENCE).toMatch(/Nothing else/);
    expect(WORKSPACE_SENTENCE, "and names the cost of getting it wrong").toMatch(/committed/);
  });
});
