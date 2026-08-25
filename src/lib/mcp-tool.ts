/**
 * mcp-tool.ts — the one place a tool is defined, and the one place a server is
 * run.
 *
 * Two halves of the same idea. `defineMcpTool` makes a tool's arguments have a
 * single definition; `serveMcpServer` makes a tool's *result* have one. Both
 * exist because the alternative was five files each writing out its own version
 * and drifting.
 *
 * ## The argument half
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
 *
 * ## The result half
 *
 * See `serveMcpServer` at the bottom. In short: every server hand-wrote the
 * ~10-line `CallToolRequestSchema` handler that maps a result into MCP content,
 * and each dropped a different field of it.
 */
import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { attachReportChannel } from "./mcp-report.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * Names a model reaches for when the schema says `number`.
 *
 * Measured, not guessed. A verification run on a real runner produced three of
 * these in a row:
 *
 *   Tool error for get_issue: Unrecognized key(s) in object: 'issue_number'
 *   Tool error for get_issue_comments: Unrecognized key(s) in object: 'issue_number'
 *   Tool error for request_close_issue: Unrecognized key(s) in object: 'issue_number'
 *
 * `issue_number` is what the GitHub REST API calls it, so a model has seen it far
 * more often than a bare `number`. Before schemas became strict, zod dropped the
 * unknown key and the defaulted `number` filled in from `ISSUE_NUMBER` — so these
 * calls silently worked, which is why nothing surfaced until strictness arrived.
 *
 * Strictness stays: it exists because a MISSPELLED key (`form` for `from`) turned
 * into a different call that succeeded, and that is a real defect. This is not
 * that. `issue_number` is not a typo for `number`, it is a synonym for it, and
 * accepting it changes nothing about what the call does.
 *
 * That is the distinction to hold on to. `positiveInt` and `stringArray` are the
 * same bargain — advertise the strict shape, be forgiving at run time about a
 * KNOWN confusion whose intent is unambiguous. It is the opposite of the APPROVE
 * case, where the runtime used to accept a value that could never work and taught
 * the model to keep asking for it.
 */
const NUMBER_ALIASES = ["issue_number", "pr_number", "pull_number", "pull_request_number"] as const;

/**
 * Fold a synonym for `number` into `number`, before validation sees it.
 *
 * Applied to whole object schemas rather than to a field, because the key itself
 * is what needs renaming and a field-level check never sees a key it does not
 * know. An alias present alongside a real `number` is ignored — the explicit one
 * wins, and nothing silently overrides it.
 */
function acceptNumberAliases(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const alias = NUMBER_ALIASES.find((name) => name in value);
  if (alias === undefined) return raw;
  const { [alias]: aliased, ...rest } = value;
  return "number" in rest ? rest : { ...rest, number: aliased };
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

function normalizeResult(result: McpToolResult): McpToolPayload {
  return typeof result === "string" ? { text: result } : result;
}

export interface McpToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => McpToolResult | Promise<McpToolResult>;
}

/**
 * A handler's result, normalised: always a text part, optionally the other two.
 *
 * Named because it is the contract between a tool and whatever serves it, and it
 * was written out inline four times in this file and destructured differently in
 * each of the five servers — three of which dropped a field the type says can be
 * there. `serveMcpServer` below is now the one place that maps it.
 */
export interface McpToolPayload {
  text: string;
  meta?: Record<string, unknown>;
  images?: McpImageBlock[];
}

/** A tool ready to be listed (`.tool`) and invoked (`.call`) by an MCP server. */
export interface BuiltMcpTool {
  readonly tool: Tool;
  call(args: Record<string, unknown>): Promise<McpToolPayload>;
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
    async call(args: Record<string, unknown>): Promise<McpToolPayload> {
      // Before validation, not inside the schema: the key is what is being
      // renamed, and a strict object rejects an unknown key before any field-level
      // rule could see it.
      const result = schema.safeParse(acceptNumberAliases(args));
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

/** Routes one `tools/call` to the tool that owns the name. */
export type McpDispatch = (name: string, args: Record<string, unknown>) => Promise<McpToolPayload>;

/** Builds an MCP server's `tools/list` array and a single `name -> call` dispatch function from a list of tool specs. */
export function buildMcpTools(specs: BuiltMcpTool[]): { tools: Tool[]; dispatch: McpDispatch } {
  const byName = new Map(specs.map((s) => [s.tool.name, s]));
  return {
    tools: specs.map((s) => s.tool),
    async dispatch(name, args) {
      const spec = byName.get(name);
      if (!spec) throw new Error(`Unknown: ${name}`);
      return spec.call(args);
    },
  };
}

/**
 * Run an MCP server over stdio: list these tools, dispatch calls to them, and map
 * every result the way `McpToolPayload` says it can be shaped.
 *
 * Each of the five servers used to write this out itself — about ten lines,
 * near-identical — and each dropped a different part of the result:
 *
 *   `github`, `atoma`   kept `meta`,   dropped `images`
 *   `web`               kept `images`, dropped `meta`
 *   `shell`, `search`   dropped both
 *
 * Nothing said so, and nothing would have caught it. The type declares all
 * three, so a `github` tool that started returning an image — `lib/issue-images.ts`
 * already exists, and `web` already uses it — or a `web` tool that set
 * `session_ends` would have been silently truncated, with no type error, because
 * each handler destructured only the subset it happened to need. That is
 * duplication of the exact thing this file exists to remove.
 *
 * `log` stays per-server rather than becoming shared: the prefixes are what
 * identify which server a line came from, in a run log that interleaves all five.
 *
 * ## The logging capability
 *
 * Declaring it is what makes `lib/mcp-report.ts` work, and the SDK then does the
 * rest of the protocol itself: it registers the `logging/setLevel` handler,
 * remembers the level the client asked for, and drops anything below it inside
 * `sendLoggingMessage`. atoma asks for `warning`, which is everything `report`
 * sends, so nothing is filtered in practice -- but a client that asked for
 * `error` would get only errors without a line of code here.
 */
export async function serveMcpServer(options: {
  /** Server name reported in the MCP handshake, e.g. `atoma-web-mcp`. */
  name: string;
  version: string;
  tools: Tool[];
  dispatch: McpDispatch;
  /** Where this server's diagnostics go. Never stdout: that is the transport. */
  log: (message: string) => void;
}): Promise<void> {
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const { text, meta, images } = await options.dispatch(name, args);
      return {
        content: [{ type: "text", text }, ...(images ?? [])],
        isError: false,
        ...(meta ? { _meta: meta } : {}),
      };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      options.log(`Tool error for ${name}: ${message}`);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  // When the client says the session is live, not when the socket comes up. A
  // notification sent before `initialize` has completed is outside what the protocol
  // allows a server to do, and a client is entitled to drop it -- which would make a
  // report raised during startup the one report that never arrives, and startup is
  // exactly when #499 happened. Everything said before this moment was held; it goes
  // out here, in order.
  //
  // No `logger` field: atoma names the server that produced a result when it
  // attaches the report, so putting the name in as well says it twice.
  server.oninitialized = () => {
    attachReportChannel((level, message) => {
      void server.sendLoggingMessage({ level, data: message }).catch((error) => {
        options.log(`could not report (${(error as Error).message}): ${message}`);
      });
    });
  };

  await server.connect(new StdioServerTransport());
}
