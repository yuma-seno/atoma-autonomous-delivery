import { describe, expect, test } from "bun:test";
import { parseCommentCommand } from "./parse_comment_command.ts";

describe("parse_comment_command.ts", () => {
  test("accepts a standalone agent command followed by instructions", () => {
    expect(parseCommentCommand("/engineer\n作業をお願いします")).toEqual({
      agent: "engineer",
      sessionMode: "continue",
      error: "",
    });
  });

  test("accepts recover as the only command-line modifier", () => {
    expect(parseCommentCommand("/engineer recover\n作業を続けてください")).toEqual({
      agent: "engineer",
      sessionMode: "recover",
      error: "",
    });
  });

  test("rejects instructions on the command line", () => {
    const result = parseCommentCommand("/engineer 作業をお願いします");
    expect(result.agent).toBe("");
    expect(result.error).toContain("Unknown command syntax");
  });

  test("parses the atoma:dispatch= comment form", () => {
    expect(parseCommentCommand("<!-- atoma:dispatch=engineer -->")).toEqual({
      agent: "engineer",
      sessionMode: "continue",
      error: "",
    });
  });

  test("ignores a non-command comment", () => {
    expect(parseCommentCommand("please help").agent).toBe("");
  });

  test("ignores an invalid (uppercase) agent name", () => {
    expect(parseCommentCommand("/Engineer uppercase").agent).toBe("");
  });
});
