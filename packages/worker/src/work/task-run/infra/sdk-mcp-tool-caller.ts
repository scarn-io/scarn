import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnyJsonObject } from "../../../common/contracts/json";
import {
  createStdioMcpTransport,
  remoteMcpTransportCandidates,
  resolveLocalMcpLaunch,
  resolveRemoteMcpEndpoint,
  type LocalMcpServerConfig,
} from "../../../common/infra/mcp-transport";
import type {
  McpContentBlock,
  McpToolCallInput,
  McpToolCallOutcome,
  McpToolCaller,
  McpToolCallPlacement,
  McpUnavailableReason,
} from "../application/mcp-tool-caller";
import {
  buildContainerMcpStdioLaunch,
  buildContainerMcpStopArgs,
} from "./docker-exec-mcp-stdio";

/**
 * {@link McpToolCaller} over the official MCP SDK client.
 *
 * Each call opens a fresh connection (stdio on the host, stdio through
 * `docker exec -i` in a container, or Streamable HTTP falling back to SSE),
 * sends one `tools/call`, and always closes the connection afterwards, which
 * stops a stdio server (and, in a container, its whole process group).
 *
 * Failure mapping:
 * - before `tools/call` is sent: a stdio server that can't be spawned or
 *   exits is `start`; an HTTP/SSE transport failure is `connect`; a JSON-RPC
 *   error or an unsupported protocol version in reply to `initialize` is
 *   `initialize`. `start` and `connect` are retried once.
 * - `tools/call` answered with JSON-RPC `MethodNotFound`, or `InvalidParams`
 *   / `InternalError` whose message says the tool is unknown / not found, is
 *   `tool_not_found` (an `isError: true` result never is);
 *   any other JSON-RPC error is a `tool_error` carrying its message.
 * - the connection dropping after `tools/call` was sent is `connect`, never
 *   retried.
 * - the caller's `signal` aborting is `aborted`; `timeoutMs` elapsing (or the
 *   SDK's own request timeout) is `timeout`. Both win over whatever error the
 *   teardown caused.
 */
export class SdkMcpToolCaller implements McpToolCaller {
  private readonly runDocker: (args: string[]) => Promise<void>;
  private readonly newPidFile: () => string;

  constructor(
    deps: {
      runDocker?: (args: string[]) => Promise<void>;
      newPidFile?: () => string;
    } = {},
  ) {
    this.runDocker = deps.runDocker ?? runDockerCli;
    this.newPidFile =
      deps.newPidFile ?? (() => `/tmp/scarn-mcp-${randomUUID()}.pid`);
  }

  async call(input: McpToolCallInput): Promise<McpToolCallOutcome> {
    const deadline = AbortSignal.timeout(input.timeoutMs);
    const signal = AbortSignal.any([input.signal, deadline]);
    const interrupted = (): McpToolCallOutcome | null => {
      if (input.signal.aborted) return { status: "aborted" };
      if (deadline.aborted) return { status: "timeout" };
      return null;
    };

    const early = interrupted();
    if (early !== null) return early;

    const attempts = this.connectionAttempts(input);
    let lastFailure: ConnectFailure | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const open of attempts) {
        const connection = open();
        const failure = await this.connect(connection, input, signal);
        if (failure === null) {
          try {
            return await callTool(connection, input, signal, interrupted);
          } finally {
            await connection.dispose();
          }
        }
        await connection.dispose();
        const stopped = interrupted();
        if (stopped !== null) return stopped;
        if (failure.reason === "initialize") {
          return unavailable(failure.reason, failure.detail);
        }
        lastFailure = failure;
      }
    }
    return lastFailure === null
      ? unavailable("connect", "no transport to try")
      : unavailable(lastFailure.reason, lastFailure.detail);
  }

  private connectionAttempts(input: McpToolCallInput): Array<() => Connection> {
    const { server } = input;
    if (server.type === "local") {
      return [() => this.openStdio(server, input.placement, input.env)];
    }
    const endpoint = resolveRemoteMcpEndpoint(server, input.env);
    return remoteMcpTransportCandidates(endpoint).map(
      (create) => () => openRemote(create(), endpoint.url),
    );
  }

  private openStdio(
    server: LocalMcpServerConfig,
    placement: McpToolCallPlacement,
    env: Record<string, string>,
  ): Connection {
    const launch = resolveLocalMcpLaunch(server, env);
    if (placement.kind === "host") {
      const [command, ...args] = launch.command;
      const transport = createStdioMcpTransport({
        command,
        args,
        env: { ...env, ...launch.environment },
        cwd: path.resolve(placement.workspaceDir, launch.cwd ?? "."),
        stderr: "pipe",
      });
      return stdioConnection(transport, () => Promise.resolve());
    }
    const pidFile = this.newPidFile();
    const docker = buildContainerMcpStdioLaunch({
      containerId: placement.containerId,
      workspaceDir: placement.workspaceDir,
      launch,
      env,
      pidFile,
    });
    const transport = createStdioMcpTransport({
      command: docker.command,
      args: docker.args,
      env: docker.env,
      stderr: "pipe",
    });
    return stdioConnection(transport, () =>
      this.runDocker(
        buildContainerMcpStopArgs({
          containerId: placement.containerId,
          pidFile,
        }),
      ).catch(() => undefined),
    );
  }

  private async connect(
    connection: Connection,
    input: McpToolCallInput,
    signal: AbortSignal,
  ): Promise<ConnectFailure | null> {
    const close = () => {
      void connection.client.close().catch(() => undefined);
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      await connection.client.connect(connection.transport, {
        signal,
        timeout: input.timeoutMs,
      });
      return null;
    } catch (caught) {
      const error = asError(caught);
      return {
        reason: isInitializeError(error)
          ? "initialize"
          : connection.unreachableReason,
        detail: connection.describe(error),
      };
    } finally {
      signal.removeEventListener("abort", close);
    }
  }
}

type Connection = {
  client: Client;
  transport: Transport;
  unreachableReason: "start" | "connect";
  describe: (error: Error) => string;
  dispose: () => Promise<void>;
};

type ConnectFailure = { reason: McpUnavailableReason; detail: string };

const STDERR_TAIL_BYTES = 2048;

function newClient(): Client {
  return new Client({ name: "scarn-mcp-tool-step", version: "0" });
}

function stdioConnection(
  transport: ReturnType<typeof createStdioMcpTransport>,
  stopInRuntime: () => Promise<void>,
): Connection {
  const client = newClient();
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  return {
    client,
    transport,
    unreachableReason: "start",
    describe: (error) => {
      const tail = stderr.trim();
      return tail === "" ? error.message : `${error.message}\n${tail}`;
    },
    dispose: async () => {
      await Promise.all([
        stopInRuntime(),
        client.close().catch(() => undefined),
      ]);
    },
  };
}

function openRemote(transport: Transport, url: URL): Connection {
  const client = newClient();
  return {
    client,
    transport,
    unreachableReason: "connect",
    describe: (error) => `${url.origin}${url.pathname}: ${error.message}`,
    dispose: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

async function callTool(
  connection: Connection,
  input: McpToolCallInput,
  signal: AbortSignal,
  interrupted: () => McpToolCallOutcome | null,
): Promise<McpToolCallOutcome> {
  try {
    const result = CallToolResultSchema.parse(
      await connection.client.callTool(
        { name: input.tool, arguments: input.args },
        CallToolResultSchema,
        { signal, timeout: input.timeoutMs },
      ),
    );
    const content = result.content.map(
      (block) => toJsonObject(block) as McpContentBlock,
    );
    if (result.isError === true) return { status: "tool_error", content };
    return {
      status: "ok",
      content,
      structuredContent:
        result.structuredContent === undefined
          ? null
          : toJsonObject(result.structuredContent),
    };
  } catch (caught) {
    const stopped = interrupted();
    if (stopped !== null) return stopped;
    const error = asError(caught);
    if (!(error instanceof McpError)) {
      return unavailable("connect", connection.describe(error));
    }
    if (error.code === REQUEST_TIMEOUT) return { status: "timeout" };
    if (error.code === CONNECTION_CLOSED) {
      return unavailable(
        "connect",
        `connection closed after tools/call was sent: ${connection.describe(error)}`,
      );
    }
    if (isToolNotFound(error)) {
      return unavailable("tool_not_found", error.message);
    }
    return {
      status: "tool_error",
      content: [{ type: "text", text: error.message }],
    };
  }
}

const CONNECTION_CLOSED: number = ErrorCode.ConnectionClosed;
const REQUEST_TIMEOUT: number = ErrorCode.RequestTimeout;
const METHOD_NOT_FOUND: number = ErrorCode.MethodNotFound;
const INVALID_PARAMS: number = ErrorCode.InvalidParams;
const INTERNAL_ERROR: number = ErrorCode.InternalError;

const UNKNOWN_TOOL_MESSAGE = /unknown tool|tool\b.*\bnot found/iu;

function isToolNotFound(error: McpError): boolean {
  if (error.code === METHOD_NOT_FOUND) return true;
  return (
    (error.code === INVALID_PARAMS || error.code === INTERNAL_ERROR) &&
    UNKNOWN_TOOL_MESSAGE.test(error.message)
  );
}

function isInitializeError(error: Error): boolean {
  if (error instanceof McpError) {
    return error.code !== CONNECTION_CLOSED && error.code !== REQUEST_TIMEOUT;
  }
  return error.message.startsWith("Server's protocol version is not supported");
}

function unavailable(
  reason: McpUnavailableReason,
  detail: string,
): McpToolCallOutcome {
  return { status: "unavailable", reason, detail };
}

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught failure
function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

function toJsonObject(value: object): AnyJsonObject {
  return JSON.parse(JSON.stringify(value)) as AnyJsonObject;
}

const execFileAsync = promisify(execFile);

async function runDockerCli(args: string[]): Promise<void> {
  await execFileAsync("docker", args, { timeout: 10_000 });
}
