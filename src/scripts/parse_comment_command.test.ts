import { describe, expect, test } from "bun:test";
import { parseCommentCommand } from "./parse_comment_command.ts";

describe("parse_comment_command.ts", () => {
  test("accepts a standalone agent command followed by instructions", () => {
    expect(parseCommentCommand("/engineer\n作業をお願いします")).toEqual({
      agent: "engineer",
      control: "",
      sessionMode: "continue",
      error: "",
    });
  });

  test("accepts recover as the only command-line modifier", () => {
    expect(parseCommentCommand("/engineer recover\n作業を続けてください")).toEqual({
      agent: "engineer",
      control: "",
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
      control: "",
      sessionMode: "continue",
      error: "",
    });
  });

  // `/stop` reaching the agent branch would dispatch a run looking for stop.md,
  // which is a failed run rather than a stopped one.
  test("a control command is taken out of the agent namespace", () => {
    expect(parseCommentCommand("/stop")).toEqual({
      agent: "",
      control: "stop",
      sessionMode: "continue",
      error: "",
    });
    expect(parseCommentCommand("/resume")).toEqual({
      agent: "",
      control: "resume",
      sessionMode: "continue",
      error: "",
    });
  });

  // The thing the person wanted exists and is one line away, so the error names it
  // rather than saying the syntax is wrong.
  test("a control command refuses an argument and points at the agent command", () => {
    const result = parseCommentCommand("/resume 続きをお願いします");
    expect(result.control).toBe("");
    expect(result.agent).toBe("");
    expect(result.error).toContain("'/<agent>'");
  });

  test("ignores a non-command comment", () => {
    expect(parseCommentCommand("please help").agent).toBe("");
  });

  test("ignores an invalid (uppercase) agent name", () => {
    expect(parseCommentCommand("/Engineer uppercase").agent).toBe("");
  });
});
