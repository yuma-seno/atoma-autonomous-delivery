#!/usr/bin/env bun
/**
 * web.ts — fetches a URL for the agent.
 *
 * Three things it does that a bare `curl` through the shell does not:
 *
 * Converts to Markdown by default. Raw HTML is mostly markup, and every byte of
 * a tool result is resent on each later inference of the run, so a page fetched
 * as HTML is paid for many times over. `raw: true` is there for the cases where
 * the markup is the point.
 *
 * Returns a picture as a picture. The core carries image blocks from a tool
 * result now, so a URL that resolves to an image reaches a vision-capable model
 * as something it can look at rather than as base64 in the prose.
 *
 * Bounds the response. A page with no limit can spend an entire context window
 * in one call.
 */
import { buildMcpTools, defineMcpTool, serveMcpServer, z, type McpToolResult } from "../../../../lib/mcp-tool.ts";
import { htmlToMarkdown } from "../../../../domain/html-to-markdown.ts";
import { sniffMimeType } from "../../../../lib/issue-images.ts";

/** Longest text returned from one fetch. */
const MAX_TEXT_CHARS = 60_000;

/** Largest image inlined, as base64 characters. */
const MAX_IMAGE_BYTES = 4_000_000;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Schemes this server will fetch.
 *
 * `z.string().url()` accepts anything `new URL()` accepts, which is every scheme
 * — `file:`, `data:`, `blob:`. The description said "http(s)" and nothing
 * enforced it, so `web__fetch` was a general local-file read: Bun's `fetch`
 * handles `file:` URLs, and this server declares `env: {}` precisely so that it
 * holds no credentials.
 *
 * That made it the cheapest way to reach the two places a credential actually
 * sits — `/proc/<pid>/environ` of a server that does hold one, and the
 * `http.extraheader` line `actions/checkout` writes into `.git/config` — without
 * going anywhere near the `shell` server or the routing rules that watch it.
 *
 * Checked here rather than in the handler so the constraint is in the JSON Schema
 * the model reads, and so a rejected call names the reason.
 */
const FETCHABLE_SCHEMES = new Set(["http:", "https:"]);

const FETCH_SCHEMA = z.object({
  url: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return FETCHABLE_SCHEMES.has(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: "must be an http:// or https:// URL; this tool fetches the web, not the local filesystem" },
    )
    .describe("Absolute http:// or https:// URL to fetch. Other schemes, including file://, are refused."),
  raw: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return the response body unchanged instead of converting HTML to Markdown."),
  method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method. Use POST only when a page requires it."),
  body: z.string().optional().describe("Request body for POST, e.g. `q=search+terms` for a form endpoint."),
});

function log(message: string): void {
  console.error(`[atoma-web] ${message}`);
}

/**
 * A browser-shaped User-Agent.
 *
 * Not deception: many sites serve an error or an empty shell to a client that
 * announces itself as a script, and an agent reading an error page instead of
 * the article learns nothing and retries.
 */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchUrl(a: z.infer<typeof FETCH_SCHEMA>): Promise<McpToolResult> {
  const started = Date.now();
  log(`fetch ${a.method} ${a.url}${a.raw ? " (raw)" : ""}`);

  let response: Response;
  try {
    response = await fetch(a.url, {
      method: a.method,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json,image/*;q=0.8,*/*;q=0.5",
        ...(a.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(a.body !== undefined ? { body: a.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Thrown, not returned. A returned string is `isError: false` -- an
    // ordinary result whose body happens to be one English sentence -- so a
    // model summarising several fetched pages had no structural signal that
    // one of them was never read. Every other server in this tree throws and
    // lets the request handler mark the result as an error; this one did not.
    throw new Error(`Could not reach ${a.url}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${a.url}; nothing was read.`);
  }

  const declared = (response.headers.get("content-type") ?? "").toLowerCase();

  // An image comes back as an image. The declared type is checked against the
  // bytes rather than trusted: a URL with no extension says nothing, and a
  // mismatch between what is announced and what is sent is what providers that
  // validate reject.
  if (declared.startsWith("image/")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = sniffMimeType(bytes);
    if (!mimeType) throw new Error(`The response from ${a.url} is not an image format that can be shown.`);
    const data = Buffer.from(bytes).toString("base64");
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`The image at ${a.url} is too large to include.`);
    log(`fetch: image ${mimeType}, ${bytes.length}B, ${Date.now() - started}ms`);
    return {
      text: `Image from ${a.url} (${mimeType}).`,
      images: [{ type: "image", data, mimeType }],
    };
  }

  const body = await response.text();
  const isHtml = declared.includes("html") || /^\s*<(!doctype|html)\b/i.test(body);
  const text = a.raw || !isHtml ? body : htmlToMarkdown(body);
  const clipped = text.length > MAX_TEXT_CHARS;

  log(
    `fetch: ${response.status}, ${body.length}B in -> ${text.length} chars out` +
      `${clipped ? " (clipped)" : ""}, ${Date.now() - started}ms`,
  );

  return {
    text:
      text.slice(0, MAX_TEXT_CHARS) +
      (clipped ? `\n\n[truncated at ${MAX_TEXT_CHARS} characters]` : ""),
  };
}

const { tools, dispatch } = buildMcpTools([
  defineMcpTool({
    name: "fetch",
    description:
      "Fetch a URL and return its content. HTML is converted to Markdown so the result is readable prose rather than markup; pass raw: true to get the body unchanged. A URL that resolves to an image is returned as an image for models that can read one. Supports POST with a form-encoded body for endpoints that require it. An unreachable host or a non-2xx status is an error, never a result: anything returned successfully is content that was actually read.",
    schema: FETCH_SCHEMA,
    handler: fetchUrl,
  }),
]);

async function main(): Promise<void> {
  await serveMcpServer({ name: "atoma-web-mcp", version: "1.0.0", tools, dispatch, log });
}
if (import.meta.main) void main();
