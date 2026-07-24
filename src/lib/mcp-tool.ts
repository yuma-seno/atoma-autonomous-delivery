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

/** A handler may return either plain text, or `{text, meta}` when the response needs extra `_meta` fields (e.g. `session_ends: true`). */
export type McpToolResult = string | { text: string; meta?: Record<string, unknown> };

function normalizeResult(result: McpToolResult): { text: string; meta?: Record<string, unknown> } {
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
  call(args: Record<string, unknown>): Promise<{ text: string; meta?: Record<string, unknown> }>;
}

export function defineMcpTool<S extends z.ZodTypeAny>(spec: McpToolSpec<S>): BuiltMcpTool {
  const { $schema: _drop, ...jsonSchema } = zodToJsonSchema(spec.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return {
    tool: { name: spec.name, description: spec.description, inputSchema: jsonSchema as Tool["inputSchema"] },
    async call(args: Record<string, unknown>): Promise<{ text: string; meta?: Record<string, unknown> }> {
      const result = spec.schema.safeParse(args);
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
  dispatch(name: string, args: Record<string, unknown>): Promise<{ text: string; meta?: Record<string, unknown> }>;
} {
  const byName = new Map(specs.map((s) => [s.tool.name, s]));
  return {
    tools: specs.map((s) => s.tool),
    async dispatch(name: string, args: Record<string, unknown>): Promise<{ text: string; meta?: Record<string, unknown> }> {
      const spec = byName.get(name);
      if (!spec) throw new Error(`Unknown: ${name}`);
      return spec.call(args);
    },
  };
}
