import { randomBytes } from "node:crypto";
import {
  MCP_BRIDGE_TOKEN_ENV,
  MCP_BRIDGE_URL_ENV,
} from "@scarn/sdk/contracts/mcp-bridge";
import type {
  OpenCodeMcpServers,
  ResolvedOpenCodeMcpServerConfig,
} from "../../../common/contracts/opencode-mcp";
import type {
  McpConnectionPool,
  McpConnectionPoolFactory,
} from "../../../work/task-run/application/mcp-connection-pool";
import type { McpToolCallPlacement } from "../../../work/task-run/application/mcp-tool-caller";
import type { ProjectWorkLogger } from "../../../work/task-run/contracts/process-project-work-types";
import { createSdkMcpConnectionPool } from "../../../work/task-run/infra/sdk-mcp-connection-pool";
import { HOST_GATEWAY_RUN_ARGS } from "../../runtime-service/infra/devcontainer-mount-injection";
import { McpBridge } from "../application/mcp-bridge";
import {
  WorkItemsBridge,
  type WorkItemsBridgeOptions,
} from "../application/work-items-bridge";
import { resolveMcpBridgeBindAddress } from "./mcp-bridge-config";
import { McpBridgeServer } from "./mcp-bridge-server";

/**
 * One step bridge per code step run (ADR 0016, ADR 0018): its own server,
 * port, 32-byte bearer token and MCP connection pool, plus the work-item
 * routes that relay to the API with the run's claim token. The run's `signal` aborting stops the
 * session: in-flight calls are aborted, the pool is closed and the server
 * stops (decision 7).
 *
 * A container-placed step reaches the bridge at `host.docker.internal`
 * (hence {@link HOST_GATEWAY_RUN_ARGS}); a host-placed one at the loopback
 * address. The token must reach only the runner process and the log masker
 * (decision 10); {@link mcpBridgeStepEnv} builds the runner's env.
 */

const CONTAINER_ENDPOINT_HOST = "host.docker.internal";
const LOOPBACK_HOST = "127.0.0.1";
const WILDCARD_BIND_ADDRESSES = new Set(["0.0.0.0", "::", "[::]"]);
const TOKEN_BYTES = 32;

export type McpBridgeSession = {
  /** The bridge's base URL as seen from the step's runner. */
  endpoint: string;
  token: string;
  /** `HOST_GATEWAY_RUN_ARGS` for a container placement, else empty. */
  runArgs: readonly string[];
  /**
   * The connection pool the bridge calls through, for worker-side calls in
   * the same run (the step's health checks), so they share its connections.
   */
  pool: Pick<McpConnectionPool, "call">;
  /** Aborts in-flight calls, closes the pool and stops the server; idempotent. */
  stop(): Promise<void>;
};

export type OpenMcpBridgeSessionInput = {
  servers: Record<string, ResolvedOpenCodeMcpServerConfig>;
  /** The step's authored servers, so a managed connection logs as `managed`. */
  authoredServers?: OpenCodeMcpServers | null | undefined;
  placement: McpToolCallPlacement;
  /** Env for the MCP servers. */
  env: Record<string, string>;
  logger?: ProjectWorkLogger | undefined;
  signal: AbortSignal;
  /**
   * Where the `/work-items/*` routes send a code step's work-item calls (the
   * run, its claim token and the API); without it they answer 502.
   */
  workItems?:
    | Pick<WorkItemsBridgeOptions, "taskRunId" | "claimToken" | "api">
    | undefined;
  /** Defaults to {@link resolveMcpBridgeBindAddress} over `process.env`. */
  bindAddress?: string | undefined;
  /** Defaults to {@link createSdkMcpConnectionPool}. */
  poolFactory?: McpConnectionPoolFactory | undefined;
};

export async function openMcpBridgeSession(
  input: OpenMcpBridgeSessionInput,
): Promise<McpBridgeSession> {
  const bindAddress =
    input.bindAddress ?? resolveMcpBridgeBindAddress(process.env);
  const stopped = new AbortController();
  const bridge = new McpBridge({
    servers: input.servers,
    authoredServers: input.authoredServers,
    placement: input.placement,
    env: input.env,
    poolFactory: input.poolFactory ?? createSdkMcpConnectionPool,
    logger: input.logger,
    signal: AbortSignal.any([input.signal, stopped.signal]),
  });
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const workItems = input.workItems
    ? new WorkItemsBridge({ ...input.workItems, logger: input.logger })
    : undefined;
  const server = new McpBridgeServer({ bridge, workItems, token, bindAddress });

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      input.signal.removeEventListener("abort", onRunAbort);
      stopped.abort();
      await Promise.all([bridge.close(), server.stop()]);
    })();
    return stopping;
  };
  const onRunAbort = () => {
    void stop();
  };

  let port: number;
  try {
    port = await server.start();
  } catch (error) {
    await stop();
    throw error;
  }
  if (input.signal.aborted) {
    await stop();
  } else {
    input.signal.addEventListener("abort", onRunAbort, { once: true });
  }

  const container = input.placement.kind === "container";
  const host = container
    ? CONTAINER_ENDPOINT_HOST
    : loopbackEndpointHost(bindAddress);
  return {
    endpoint: `http://${host}:${String(port)}`,
    token,
    runArgs: container ? HOST_GATEWAY_RUN_ARGS : [],
    pool: bridge.pool,
    stop,
  };
}

/** `{ SCARN_MCP_BRIDGE_URL, SCARN_MCP_BRIDGE_TOKEN }` for the runner's env. */
export function mcpBridgeStepEnv(
  session: Pick<McpBridgeSession, "endpoint" | "token">,
): Record<string, string> {
  return {
    [MCP_BRIDGE_URL_ENV]: session.endpoint,
    [MCP_BRIDGE_TOKEN_ENV]: session.token,
  };
}

function loopbackEndpointHost(bindAddress: string): string {
  if (WILDCARD_BIND_ADDRESSES.has(bindAddress)) return LOOPBACK_HOST;
  return bindAddress.includes(":") && !bindAddress.startsWith("[")
    ? `[${bindAddress}]`
    : bindAddress;
}
