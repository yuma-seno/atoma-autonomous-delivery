import { describe, expect, test } from "bun:test";
import { buildArgv } from "./get_config_value.ts";

describe("get_config_value.ts buildArgv", () => {
  test("quotes path and fallback", () => {
    expect(buildArgv("limits.agent_handoffs", "5")).toEqual(['"limits.agent_handoffs"', '"5"']);
  });
  test("omits fallback when not given", () => {
    expect(buildArgv("labels.in_progress")).toEqual(['"labels.in_progress"']);
  });
});
