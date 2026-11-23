/**
 * `context.mcp` for code steps (ADR 0016): one client per server in the
 * step's `mcps`, with a method per catalog tool (`withTools`) and an untyped
 * `call(toolName, args)` escape hatch.
 *
 * The real client posts each call to the worker's per-run MCP bridge
 * (`contracts/mcp-bridge.ts`), found through `SCARN_MCP_BRIDGE_URL` and
 * `SCARN_MCP_BRIDGE_TOKEN`, which are read on the first call. Arguments are
 * parsed with the catalog tool's `input` before sending, and when the tool
 * declares `output`, its `structuredContent` is parsed with it, exactly as an
 * `mcp_tool` step's result. Failures become the MCP error classes of
 * `mcp-errors.ts`.
 */
import type { ZodType } from "zod";
import { prettifyError, z } from "zod";
import {
  MCP_BRIDGE_CALL_METHOD,
  MCP_BRIDGE_CALL_PATH,
  MCP_BRIDGE_TOKEN_ENV,
  MCP_BRIDGE_URL_ENV,
  mcpBridgeCallResponseSchema,
  mcpBridgeContentBlockSchema,
  type McpBridgeCallResponse,
} from "../../contracts/mcp-bridge";
import type {
  McpContentBlock,
  McpToolContentResult,
} from "../../pipelines/types";
import type { McpTool } from "../mcp-tools/catalog";
import { mcpHandleCatalog, type McpHandle } from "./define-mcp";
import type { McpToolArgs, McpToolStepResult } from "./define-mcp-tool-step";
import {
  McpArgsError,
  McpOutputInvalidError,
  McpTimeoutError,
  McpToolError,
  McpUnavailableError,
} from "./mcp-errors";
import type { StepError } from "./step-error";

/** Per-call options for a `context.mcp` call. */
export type McpCallOptions = {
  /** Caps this call; the worker also applies the server's own limit. */
  readonly timeoutMs?: number;
  /** Aborts the call; the promise rejects with the signal's reason. */
  readonly signal?: AbortSignal;
};

/** The method `context.mcp.<server>.<tool>` for one catalog tool. */
export type McpToolMethod<TTool extends McpTool> = (
  args: McpToolArgs<TTool>,
  options?: McpCallOptions,
) => Promise<McpToolStepResult<TTool>>;

/** The untyped `context.mcp.<server>.call(toolName, args)` escape hatch. */
export type McpUntypedCall = (
  tool: string,
  args?: Record<string, unknown>,
  options?: McpCallOptions,
) => Promise<McpToolContentResult>;

/** A handle's catalog tools by catalog key; empty before `withTools`. */
export type McpHandleToolsOf<THandle> =
  THandle extends McpHandle<string, infer TTools>
    ? TTools extends Record<string, McpTool>
      ? TTools
      : Record<never, never>
    : Record<never, never>;

/**
 * One server's client. A catalog tool keyed `call` is reachable only through
 * the escape hatch, since `call` itself is reserved for it.
 */
export type McpClient<THandle extends McpHandle> = McpToolMethods<
  McpHandleToolsOf<THandle>
> & { readonly call: McpUntypedCall };

type McpToolMethods<TTools extends Record<string, McpTool>> = {
  readonly [K in keyof TTools as K extends "call" ? never : K]: McpToolMethod<
    TTools[K]
  >;
};

/** `context.mcp`: one client per server key in the step's `mcps`. */
export type McpClients<TMcps extends Record<string, McpHandle>> = {
  readonly [K in keyof TMcps]: McpClient<TMcps[K]>;
};

/** One call as the client sees it once the tool is resolved. */
export type McpInvocation = {
  /** The server key in `mcps`. */
  readonly server: string;
  /** The tool's name on the server. */
  readonly toolName: string;
  /** The catalog key, or `undefined` for an untyped `call`. */
  readonly catalogKey: string | undefined;
  readonly args: Record<string, unknown>;
  readonly options: McpCallOptions;
};

/**
 * Produces a call's raw result: the tool's `structuredContent` (or `null`)
 * plus its content, or the result a fake returned for a catalog tool.
 */
export type McpInvoker = (call: McpInvocation) => Promise<McpRawResult>;

export type McpRawResult =
  | { readonly kind: "content"; readonly result: McpToolContentResult }
  | { readonly kind: "value"; readonly value: unknown };

const contentResultSchema = z.object({
  content: z.array(mcpBridgeContentBlockSchema),
  structuredContent: z.record(z.string(), z.unknown()).nullable(),
});

function label(server: string, toolName: string): string {
  return `MCP tool ${server}.${toolName}`;
}

function assertTimeout(
  server: string,
  toolName: string,
  options: McpCallOptions,
): void {
  const { timeoutMs } = options;
  if (timeoutMs === undefined) return;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new McpArgsError(
      `${label(server, toolName)}: timeoutMs must be a positive integer, got ${String(timeoutMs)}.`,
    );
  }
}

function asArgsRecord(
  server: string,
  toolName: string,
  // eslint-disable-next-line local/no-unknown-parameter-type -- runtime guard over author-supplied args
  value: unknown,
): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new McpArgsError(
    `${label(server, toolName)}: arguments must be an object.`,
  );
}

function parseArgs(
  server: string,
  tool: McpTool,
  // eslint-disable-next-line local/no-unknown-parameter-type -- runtime guard over author-supplied args
  args: unknown,
): Record<string, unknown> {
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) {
    throw new McpArgsError(
      `${label(server, tool.name)}: arguments don't match the catalog's input schema:\n${prettifyError(parsed.error)}`,
    );
  }
  return asArgsRecord(server, tool.name, parsed.data);
}

function parseOutput(
  server: string,
  tool: McpTool,
  output: ZodType,
  // eslint-disable-next-line local/no-unknown-parameter-type -- validated against the catalog's output schema
  value: unknown,
): unknown {
  if (value === null || value === undefined) {
    throw new McpOutputInvalidError(
      `${label(server, tool.name)} returned no structuredContent, but the catalog declares an output schema.`,
    );
  }
  const parsed = output.safeParse(value);
  if (!parsed.success) {
    throw new McpOutputInvalidError(
      `${label(server, tool.name)}: structuredContent doesn't match the catalog's output schema:\n${prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function parseContentResult(
  server: string,
  toolName: string,
  // eslint-disable-next-line local/no-unknown-parameter-type -- validated against the content result shape
  value: unknown,
): McpToolContentResult {
  const parsed = contentResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpOutputInvalidError(
      `${label(server, toolName)}: the result is not an MCP content result:\n${prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function catalogResult(
  server: string,
  tool: McpTool,
  raw: McpRawResult,
): unknown {
  const output = tool.output;
  if (raw.kind === "content") {
    return output === undefined
      ? raw.result
      : parseOutput(server, tool, output, raw.result.structuredContent);
  }
  return output === undefined
    ? parseContentResult(server, tool.name, raw.value)
    : parseOutput(server, tool, output, raw.value);
}

function untypedResult(
  server: string,
  toolName: string,
  raw: McpRawResult,
): McpToolContentResult {
  return raw.kind === "content"
    ? raw.result
    : parseContentResult(server, toolName, raw.value);
}

function buildClient(
  server: string,
  handle: McpHandle,
  invoke: McpInvoker,
): Record<string, unknown> {
  const client: Record<string, unknown> = {};
  const tools = mcpHandleCatalog(handle)?.tools ?? {};
  for (const [catalogKey, tool] of Object.entries(tools)) {
    if (catalogKey === "call") continue;
    client[catalogKey] = async (
      // eslint-disable-next-line local/no-unknown-parameter-type -- typed by McpToolMethod, parsed here
      args: unknown,
      options: McpCallOptions = {},
    ) => {
      assertTimeout(server, tool.name, options);
      const parsedArgs = parseArgs(server, tool, args);
      const raw = await invoke({
        server,
        toolName: tool.name,
        catalogKey,
        args: parsedArgs,
        options,
      });
      return catalogResult(server, tool, raw);
    };
  }
  const call: McpUntypedCall = async (toolName, args = {}, options = {}) => {
    assertTimeout(server, toolName, options);
    const raw = await invoke({
      server,
      toolName,
      catalogKey: undefined,
      args: asArgsRecord(server, toolName, args),
      options,
    });
    return untypedResult(server, toolName, raw);
  };
  client["call"] = call;
  return Object.freeze(client);
}

/** Builds `McpClients` over any invoker; the real and the fake clients share it. */
export function buildMcpClients<TMcps extends Record<string, McpHandle>>(
  handles: TMcps,
  invoke: McpInvoker,
): McpClients<TMcps> {
  const clients: Record<string, unknown> = {};
  for (const [server, handle] of Object.entries(handles)) {
    clients[server] = buildClient(server, handle, invoke);
  }
  return Object.freeze(clients) as McpClients<TMcps>;
}

export type McpBridgeFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type CodeStepMcpClientOptions = {
  /** Where the bridge env vars are read from; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: McpBridgeFetch;
};

type BridgeEndpoint = { readonly url: string; readonly token: string };

function firstText(content: readonly McpContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === "text" && typeof block["text"] === "string") {
      return block["text"];
    }
  }
  return undefined;
}

function outcomeResult(
  call: McpInvocation,
  outcome: McpBridgeCallResponse,
): McpRawResult {
  const name = label(call.server, call.toolName);
  switch (outcome.status) {
    case "ok":
      return {
        kind: "content",
        result: {
          content: outcome.content,
          structuredContent: outcome.structuredContent,
        },
      };
    case "tool_error": {
      const text = firstText(outcome.content);
      throw new McpToolError(
        text === undefined
          ? `${name} returned an error.`
          : `${name} returned an error: ${text}`,
        outcome.content,
      );
    }
    case "unavailable":
      throw new McpUnavailableError(
        `${name} is unavailable (${outcome.reason}): ${outcome.detail}`,
        outcome.reason,
        outcome.detail,
      );
    case "timeout":
      throw new McpTimeoutError(`${name} timed out.`);
  }
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    return text;
  }
  return text;
}

async function statusError(
  call: McpInvocation,
  response: Response,
): Promise<StepError> {
  const name = label(call.server, call.toolName);
  const detail = await errorText(response);
  switch (response.status) {
    case 400:
      return new McpArgsError(
        `${name}: the MCP bridge rejected the request: ${detail}`,
      );
    case 413:
      return new McpArgsError(
        `${name}: the arguments are too large for the MCP bridge.`,
      );
    case 404:
      return new McpUnavailableError(
        `${name}: server "${call.server}" isn't one of this step's MCP servers.`,
        "not_declared",
        detail,
      );
    case 401:
      return new McpUnavailableError(
        `${name}: the MCP bridge rejected this run's token.`,
        "bridge",
        detail,
      );
    default:
      return new McpUnavailableError(
        `${name}: the MCP bridge answered HTTP ${String(response.status)}.`,
        "bridge",
        detail,
      );
  }
}

function bridgeInvoker(options: CodeStepMcpClientOptions): McpInvoker {
  let endpoint: BridgeEndpoint | undefined;
  const resolveEndpoint = (call: McpInvocation): BridgeEndpoint => {
    if (endpoint !== undefined) return endpoint;
    const env =
      options.env ??
      (
        globalThis as {
          process?: { env?: Readonly<Record<string, string | undefined>> };
        }
      ).process?.env ??
      {};
    const url = env[MCP_BRIDGE_URL_ENV]?.trim();
    const token = env[MCP_BRIDGE_TOKEN_ENV]?.trim();
    if (!url || !token) {
      throw new McpUnavailableError(
        `${label(call.server, call.toolName)} can't be called: ${MCP_BRIDGE_URL_ENV} and ${MCP_BRIDGE_TOKEN_ENV} aren't set, so this code isn't running inside a Scarn run. In a unit test, pass createFakeMcpClients(...) as context.mcp.`,
        "no_bridge",
        `missing ${[!url ? MCP_BRIDGE_URL_ENV : null, !token ? MCP_BRIDGE_TOKEN_ENV : null].filter((name) => name !== null).join(", ")}`,
      );
    }
    endpoint = {
      url: `${url.replace(/\/+$/, "")}${MCP_BRIDGE_CALL_PATH}`,
      token,
    };
    return endpoint;
  };
  const doFetch: McpBridgeFetch =
    options.fetch ?? ((url, init) => fetch(url, init));

  return async (call) => {
    const { url, token } = resolveEndpoint(call);
    const { signal, timeoutMs } = call.options;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: MCP_BRIDGE_CALL_METHOD,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          server: call.server,
          tool: call.toolName,
          args: call.args,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      throw new McpUnavailableError(
        `${label(call.server, call.toolName)}: couldn't reach the MCP bridge.`,
        "bridge",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status !== 200) throw await statusError(call, response);
    const body: unknown = await response.json().catch(() => undefined);
    const outcome = mcpBridgeCallResponseSchema.safeParse(body);
    if (!outcome.success) {
      throw new McpUnavailableError(
        `${label(call.server, call.toolName)}: the MCP bridge sent a response this SDK doesn't understand.`,
        "bridge",
        prettifyError(outcome.error),
      );
    }
    return outcomeResult(call, outcome.data);
  };
}

/**
 * The real `context.mcp` of a code step: calls go through the worker's MCP
 * bridge. Outside a run (no bridge env) every call throws
 * `McpUnavailableError`; use `createFakeMcpClients` in unit tests.
 */
export function createCodeStepMcpClient<
  TMcps extends Record<string, McpHandle>,
>(handles: TMcps, options: CodeStepMcpClientOptions = {}): McpClients<TMcps> {
  return buildMcpClients(handles, bridgeInvoker(options));
}
