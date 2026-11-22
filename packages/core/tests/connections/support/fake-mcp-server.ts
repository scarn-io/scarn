import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * The `/mcp` endpoint of {@link FakeMcpOAuth}: a minimal Streamable HTTP
 * MCP server that answers with JSON only. It accepts only live access tokens,
 * answers `initialize` with a session id, `notifications/initialized` with
 * 202, and serves `tools/list` in `toolPages` pages of two tools named
 * `<toolPrefix>-<page>-<index>`. A `GET`
 * (the optional SSE stream) gets 405 and a `DELETE` ends the session.
 *
 * `tools/call` counts one effect per call by tool name. `slow-tool` answers
 * after `slowToolMs`, and `echo-bearer` answers with the `Authorization`
 * header it received. `stream-tool` answers with an SSE stream of progress
 * events (see {@link StreamToolArguments}) produced only as it is read, then
 * the result. With `responseMode = "sse"` every JSON-RPC reply is
 * sent as one `text/event-stream` event instead. Every request's headers
 * are recorded.
 */

export type FakeMcpServerFault =
  | "mcp_unauthorized_once"
  | "mcp_unauthorized"
  | "mcp_redirect"
  | "mcp_oversize"
  | "mcp_slow"
  | "mcp_server_error";

export type FakeMcpServerCall = {
  method: string;
  /** The JSON-RPC method, for a POST. */
  rpcMethod: string | null;
  authorization: string | null;
  sessionId: string | null;
  /** Every request header, as received. */
  headers: Headers;
  /** Settles when the request's signal aborts. */
  aborted: Promise<void>;
};

export type FakeMcpServerResponseMode = "json" | "sse";

export const FAKE_MCP_SLOW_TOOL = "slow-tool";
export const FAKE_MCP_ECHO_BEARER_TOOL = "echo-bearer";
export const FAKE_MCP_STREAM_TOOL = "stream-tool";
/** Declared by the second tool on every `tools/list` page. */
export const FAKE_MCP_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    results: { type: "array", items: { type: "string" } },
    "x-vendor": { $ref: "#/$defs/extra" },
  },
  required: ["results"],
  $defs: { extra: { type: ["string", "null"] } },
};

const jsonRpcIdSchema = z.union([z.string(), z.number()]);

const streamToolArgumentsSchema = z.object({
  events: z.number().int().nonnegative().default(3),
  intervalMs: z.number().nonnegative().default(0),
  padBytes: z.number().int().nonnegative().default(0),
  hang: z.boolean().default(false),
});

/** Arguments of `stream-tool`: progress events, their spacing and size, and whether to stall instead of finishing. */
export type StreamToolArguments = z.input<typeof streamToolArgumentsSchema>;

/** Marks every non-2xx `/mcp` body, so tests can check it never leaks. */
export const FAKE_MCP_ERROR_MARKER = "fake-mcp-error-body";

const DEFAULT_REDIRECT_TO = "https://example.com/mcp";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

export type FakeMcpServerOptions = {
  slowMs: number;
  fault: () => FakeMcpServerFault | undefined;
  clearFault: () => void;
  isLiveAccessToken: (token: string) => boolean;
  /** The protected-resource metadata URL a 401's challenge names. */
  resourceMetadataUrl: () => string;
  /** Prefixes every listed tool's name; `notion-tool` by default. */
  toolPrefix?: string;
};

export class FakeMcpServer {
  readonly calls: FakeMcpServerCall[] = [];
  /** How many `tools/list` pages are served, two tools per page. */
  toolPages = 1;
  /** Where the `mcp_redirect` fault sends the client. */
  redirectTo = DEFAULT_REDIRECT_TO;
  responseMode: FakeMcpServerResponseMode = "json";
  /** How long `slow-tool` waits before it answers. */
  slowToolMs = 0;
  /** Sessions `initialize` created that no `DELETE` has ended yet. */
  readonly openSessions = new Set<string>();
  /** `tools/call` count by tool name. */
  readonly effects = new Map<string, number>();
  /** Progress events `stream-tool` has produced, each only when its stream was pulled. */
  streamPulls = 0;

  constructor(private readonly options: FakeMcpServerOptions) {}

  reset(): void {
    this.calls.length = 0;
    this.toolPages = 1;
    this.redirectTo = DEFAULT_REDIRECT_TO;
    this.responseMode = "json";
    this.slowToolMs = 0;
    this.openSessions.clear();
    this.effects.clear();
    this.streamPulls = 0;
  }

  effectCount(toolName: string): number {
    return this.effects.get(toolName) ?? 0;
  }

  /** Requests with the given JSON-RPC method (or HTTP method for non-POSTs). */
  callsTo(method: string): FakeMcpServerCall[] {
    return this.calls.filter(
      (call) => (call.rpcMethod ?? call.method) === method,
    );
  }

  async handle(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const sessionId = request.headers.get("mcp-session-id");
    let message: { id?: unknown; method?: unknown; params?: unknown } = {};
    if (request.method === "POST") {
      try {
        message = (await request.json()) as typeof message;
      } catch {
        message = {};
      }
    }
    this.calls.push({
      method: request.method,
      rpcMethod: typeof message.method === "string" ? message.method : null,
      authorization,
      sessionId,
      headers: new Headers(request.headers),
      aborted: new Promise<void>((resolve) => {
        if (request.signal.aborted) {
          resolve();
        }
        request.signal.addEventListener("abort", () => {
          resolve();
        });
      }),
    });
    const errorBody = (status: number) =>
      new Response(`${FAKE_MCP_ERROR_MARKER} ${String(status)}`, {
        status,
        headers: { "content-type": "text/plain" },
      });

    const fault = this.options.fault();
    if (fault === "mcp_slow") {
      await sleep(this.options.slowMs);
    }
    if (fault === "mcp_redirect") {
      return new Response(errorBody(302).body, {
        status: 302,
        headers: { location: this.redirectTo },
      });
    }
    const token = authorization?.match(/^Bearer (.+)$/u)?.[1] ?? "";
    if (
      fault === "mcp_unauthorized" ||
      fault === "mcp_unauthorized_once" ||
      !this.options.isLiveAccessToken(token)
    ) {
      if (fault === "mcp_unauthorized_once") {
        this.options.clearFault();
      }
      const response = errorBody(401);
      response.headers.set(
        "www-authenticate",
        `Bearer error="invalid_token", resource_metadata="${this.options.resourceMetadataUrl()}"`,
      );
      return response;
    }
    if (request.method === "GET") {
      return errorBody(405);
    }
    if (fault === "mcp_server_error") {
      return errorBody(500);
    }
    if (request.method === "DELETE") {
      if (sessionId !== null) {
        this.openSessions.delete(sessionId);
      }
      return new Response(null, { status: 200 });
    }
    if (request.method !== "POST" || typeof message.method !== "string") {
      return errorBody(400);
    }
    if (message.id === undefined) {
      return new Response(null, { status: 202 });
    }
    if (fault === "mcp_oversize") {
      const chunk = new Uint8Array(256 * 1024).fill(32);
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 64) {
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const send = (payload: object, headers: Record<string, string> = {}) => {
      const json = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        ...payload,
      });
      return this.responseMode === "sse"
        ? new Response(`event: message\ndata: ${json}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream", ...headers },
          })
        : new Response(json, {
            status: 200,
            headers: { "content-type": "application/json", ...headers },
          });
    };
    const reply = (result: object, headers: Record<string, string> = {}) =>
      send({ result }, headers);
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "initialize") {
      const newSessionId = `fake-session-${randomBytes(8).toString("hex")}`;
      this.openSessions.add(newSessionId);
      return reply(
        {
          protocolVersion: params["protocolVersion"],
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp-server", version: "0" },
        },
        { "mcp-session-id": newSessionId },
      );
    }
    if (message.method === "tools/list") {
      const page =
        typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
      const next = page + 1;
      return reply({
        tools: [0, 1].map((index) => ({
          name: `${this.options.toolPrefix ?? "notion-tool"}-${String(page)}-${String(index)}`,
          description: `Fake tool ${String(index)} on page ${String(page)}`,
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
          ...(index === 0
            ? { annotations: { readOnlyHint: true } }
            : {
                title: `Fake Tool ${String(index)}`,
                outputSchema: FAKE_MCP_TOOL_OUTPUT_SCHEMA,
              }),
        })),
        ...(next < this.toolPages ? { nextCursor: String(next) } : {}),
      });
    }
    if (message.method === "tools/call") {
      const name = typeof params["name"] === "string" ? params["name"] : "";
      this.effects.set(name, this.effectCount(name) + 1);
      if (name === FAKE_MCP_SLOW_TOOL) {
        await sleep(this.slowToolMs);
      }
      if (name === FAKE_MCP_STREAM_TOOL) {
        return this.streamToolCall(
          jsonRpcIdSchema.parse(message.id),
          streamToolArgumentsSchema.parse(params["arguments"] ?? {}),
        );
      }
      const text =
        name === FAKE_MCP_ECHO_BEARER_TOOL
          ? (authorization ?? "")
          : `called ${name}`;
      return reply({ content: [{ type: "text", text }] });
    }
    return send({ error: { code: -32601, message: "Method not found" } });
  }

  private streamToolCall(
    id: z.output<typeof jsonRpcIdSchema>,
    args: z.output<typeof streamToolArgumentsSchema>,
  ): Response {
    const padding = "x".repeat(args.padBytes);
    let sent = 0;
    const event = (payload: object) =>
      new TextEncoder().encode(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n\n`,
      );
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            if (sent > 0) {
              await sleep(args.intervalMs);
            }
            if (sent >= args.events) {
              if (args.hang) {
                await new Promise(() => undefined);
              }
              controller.enqueue(
                event({
                  id,
                  result: { content: [{ type: "text", text: "streamed" }] },
                }),
              );
              controller.close();
              return;
            }
            this.streamPulls += 1;
            controller.enqueue(
              event({
                method: "notifications/progress",
                params: { progress: sent, padding },
              }),
            );
            sent += 1;
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
}
