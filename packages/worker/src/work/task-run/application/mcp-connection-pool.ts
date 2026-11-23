import type { AnyJsonObject } from "../../../common/contracts/json";
import type { ResolvedOpenCodeMcpServerConfig } from "../../../common/contracts/opencode-mcp";
import type {
  McpToolCallOutcome,
  McpToolCallPlacement,
} from "./mcp-tool-caller";

/**
 * Port for calling MCP tools many times during one run (a code step calling
 * tools in a loop) without starting a server per call.
 *
 * A pool is made per run for a fixed set of resolved servers. It opens one
 * connection per server the first time that server is called (concurrent
 * first calls share the one opening) and keeps it until {@link closeAll}.
 * A connection found dead before a request is sent is reopened once; a
 * request already sent is never retried, so a connection dying mid-request
 * makes that call `unavailable: connect`. Failed openings are not cached: the
 * next call to that server tries again.
 *
 * Each call's `timeoutMs` bounds the call, including waiting for the
 * connection to open. The run's `signal` aborting, or {@link closeAll},
 * aborts in-flight calls (`aborted`) and closes every connection; later
 * calls return `aborted`.
 */
export interface McpConnectionPool {
  call(serverKey: string, call: McpPooledToolCall): Promise<McpToolCallOutcome>;
  /** Closes every connection (stopping stdio servers); idempotent. */
  closeAll(): Promise<void>;
}

export type McpPooledToolCall = {
  tool: string;
  args: AnyJsonObject;
  timeoutMs: number;
  signal: AbortSignal;
};

export type McpConnectionPoolInput = {
  servers: Record<string, ResolvedOpenCodeMcpServerConfig>;
  placement: McpToolCallPlacement;
  env: Record<string, string>;
  signal: AbortSignal;
  /** Called each time the pool starts opening a connection to a server. */
  onOpen?: (event: McpConnectionOpenEvent) => void;
};

export type McpConnectionOpenEvent = {
  serverKey: string;
  server: ResolvedOpenCodeMcpServerConfig;
  /** True when replacing a connection that died. */
  reopen: boolean;
};

export type McpConnectionPoolFactory = (
  input: McpConnectionPoolInput,
) => McpConnectionPool;
