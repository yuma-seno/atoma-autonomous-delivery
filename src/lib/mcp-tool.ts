/**
 * mcp-tool.ts — single-definition MCP tool helper.
 *
 * Before this, every MCP tool in mcp/github.ts and mcp/atoma.ts had TWO
 * independent, hand-written descriptions of its own arguments: a JSON
 * Schema literal (the `inputSchema` sent to the LLM) and a handler body
 * full of unchecked `a.title as string` casts on a bare
 * `Record<string, unknown>`. Nothing linked the two — a schema change and
 * a handler change could silently drift apart, and a malformed argument
 * from the LLM was only ever caught (if at all) deep inside a `gh` call.
 *
 * `defineMcpTool` closes that gap: a single Zod schema is both (a) compiled
 * to the JSON Schema advertised to the LLM, and (b) used to validate +
 * parse incoming arguments into a properly-typed object before the handler
 * ever runs. A malformed call is now rejected up front with a readable
 * "field: reason" message, and the handler's argument type is inferred
 * directly from the schema — no casts possible.
 *
 * NOTE: imports from "zod/v3", not "zod". zod-to-json-schema (as installed)
 * only recognizes schemas built from the classic v3 constructor internals;
 * schemas built via the bare "zod" entrypoint round-trip fine through
 * `.parse()`/`.safeParse()` but silently produce an empty `{}` JSON Schema
 * when passed to `zodToJsonSchema()`. Confirmed by direct probing during
 * implementation — always import `z` from "zod/v3" in files that build
 * MCP tool schemas.
 */
import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export { z };

/**
 * A positive integer that also accepts its own decimal string form.
 *
 * Weaker models routinely send `"185"` where the advertised JSON Schema says
 * `number` -- observed repeatedly in production against `get_issue`,
 * `get_issue_comments`, and the `limit` filters, each failure costing a whole
 * inference iteration to relay back a message the model then ignored. The
 * schema shown to the model is unchanged (`z.coerce.number()` still emits
 * `{"type":"number"}`); only the runtime becomes forgiving. Genuinely
 * non-numeric input still fails: `"abc"` coerces to `NaN` and is rejected by
 * `.int()`, and `""`/`"0"` are rejected by `.positive()`.
 */
export function positiveInt(description: string) {
  return z.coerce.number().int().positive().describe(description);
}

/**
 * An array of strings that also accepts a single bare string.
 *
 * Same rationale as [`positiveInt`]: models send `labels: "atoma/sub-issue"`
 * for a one-element list. `z.preprocess` keeps the advertised schema an array,
 * so the model is still told the correct shape.
 */
export function stringArray(description: string) {
  return z
    .preprocess(
      (value) => (typeof value === "string" ? [value] : value),
      z.array(z.string()),
    )
    .describe(description);
}

/** An image in MCP's own content-block shape, which the Atoma core maps per provider. */
export interface McpImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * A handler may return plain text, or an object when the response needs more
 * than text: `meta` for extra `_meta` fields (e.g. `session_ends: true`), and
 * `images` for pictures a vision-capable model should see rather than read.
 */
export type McpToolResult =
  | string
  | { text: string; meta?: Record<string, unknown>; images?: McpImageBlock[] };

function normalizeResult(result: McpToolResult): {
  text: string;
  meta?: Record<string, unknown>;
  images?: McpImageBlock[];
} {
  return typeof result === "string" ? { text: result } : result;
}

export interface McpToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => McpToolResult | Promise<McpToolResult>;
}

/** A tool ready to be listed (`.tool`) and invoked (`.call`) by an MCP server. */
export interface BuiltMcpTool {
  readonly tool: Tool;
  call(args: Record<string, unknown>): Promise<{ text: string; meta?: Record<string, unknown>; images?: McpImageBlock[] }>;
}

/**
 * The tool's schema, with unknown keys refused instead of dropped.
 *
 * Zod's default is to strip what it does not recognise, which turns a misspelled
 * argument into a different call that succeeds. `get_issue_comments({number: 42,
 * form: 3})` -- `from` mistyped -- silently returned the default last five
 * comments, and the agent read that as the three it asked for. `create_issue`
 * with `label` instead of `labels` created an issue with no labels and reported
 * success.
 *
 * Strict makes the same call an error naming the key, which the agent can act on.
 * It also puts `additionalProperties: false` in the advertised JSON Schema, so
 * the constraint reaches the model before the call rather than after.
 *
 * `merge_gates` already made this decision for configuration: an unrecognised key
 * is an error there, because a silently-dropped one is indistinguishable from a
 * setting nobody needed. The same argument holds for a tool call.
 *
 * The cast is safe in the direction that matters: `.strict()` narrows what is
 * accepted and leaves the parsed output type untouched.
 */
function refuseUnknownKeys<S extends z.ZodTypeAny>(schema: S): S {
  return (schema instanceof z.ZodObject ? schema.strict() : schema) as S;
}

export function defineMcpTool<S extends z.ZodTypeAny>(spec: McpToolSpec<S>): BuiltMcpTool {
  const schema = refuseUnknownKeys(spec.schema);
  const { $schema: _drop, ...jsonSchema } = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return {
    tool: { name: spec.name, description: spec.description, inputSchema: jsonSchema as Tool["inputSchema"] },
    async call(
      args: Record<string, unknown>,
    ): Promise<{ text: string; meta?: Record<string, unknown>; images?: McpImageBlock[] }> {
      const result = schema.safeParse(args);
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid arguments for ${spec.name}: ${message}`);
      }
      return normalizeResult(await spec.handler(result.data));
    },
  };
}

/** Builds an MCP server's `tools/list` array and a single `name -> call` dispatch function from a list of tool specs. */
export function buildMcpTools(specs: BuiltMcpTool[]): {
  tools: Tool[];
  dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; meta?: Record<string, unknown>; images?: McpImageBlock[] }>;
} {
  const byName = new Map(specs.map((s) => [s.tool.name, s]));
  return {
    tools: specs.map((s) => s.tool),
    async dispatch(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ text: string; meta?: Record<string, unknown>; images?: McpImageBlock[] }> {
      const spec = byName.get(name);
      if (!spec) throw new Error(`Unknown: ${name}`);
      return spec.call(args);
    },
  };
}
