/**
 * mock-llm-server.ts — a minimal OpenAI-compatible `/chat/completions` HTTP
 * server for E2E tests.
 *
 * The real `atoma` binary's OpenAI client (`OPENAI_BASE_URL` env var) is
 * pointed at this server, so the *actual* agent inference loop runs
 * unmodified -- only the LLM's decisions are canned/scripted, via a queue of
 * responses returned in order, one per HTTP request received.
 */

export interface QueuedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface QueuedResponse {
  /** Assistant text content. Omit when returning tool_calls. */
  content?: string;
  toolCalls?: QueuedToolCall[];
}

export interface MockLlmServer {
  url: string;
  /** Raw JSON bodies of every request received so far, in order. */
  requests: {
    messages: { role: string; content?: unknown }[];
    tools?: { function?: { name?: string } }[];
  }[];
  stop(): void;
}

export function startMockLlmServer(responses: QueuedResponse[]): MockLlmServer {
  const queue = [...responses];
  const requests: MockLlmServer["requests"] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requests.push((await req.json()) as MockLlmServer["requests"][number]);

      const next = queue.shift();
      if (!next) {
        return Response.json({ error: { message: "mock-llm-server: no more queued responses" } }, { status: 500 });
      }

      const message = next.toolCalls
        ? {
            role: "assistant",
            content: null,
            tool_calls: next.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }
        : { role: "assistant", content: next.content ?? "" };

      return Response.json({
        choices: [{ message, finish_reason: next.toolCalls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}
