/**
 * What a launch hands the step besides its runtime: the OpenCode server an
 * agent step prompts, or the resolved MCP server an `mcp_tool` step calls.
 */
import type { ResolvedOpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { McpToolCallPlacement } from "../application/mcp-tool-caller";

/**
 * The running OpenCode server a prompt-driven step talks to. Present on a
 * `LaunchedRuntime` only when the launch started one.
 */
export type AgentRuntime = {
  /** Runtime-neutral agent base URL (formerly `aiBaseUrl`). */
  baseUrl: string;
  /** Basic-auth password the server was started with. */
  password: string;
  /** OpenCode version the server was launched as; readiness probes expect it. */
  version: string;
  /**
   * Directory inside the runtime container where the agent's logs are written
   * and `docker exec` tailing reads them from.
   */
  logDirectory: string;
  /**
   * Host log file the agent's stdout/stderr is written to for `no_workspace`
   * runs (tailed directly from the host). `null`/absent for container runs,
   * where {@link logDirectory} + `docker exec` tailing is used instead.
   */
  hostLogPath?: string | null | undefined;
};

/**
 * The resolved MCP servers of a step whose worker calls them (an `mcp_tool`
 * step's one tool call, or a code step's calls through the MCP bridge), and
 * where to call them from. The launch resolves the step's servers exactly as
 * for an agent (refs, connectors, managed relay, inferred env) but starts no
 * OpenCode; the worker process calls the tools itself.
 */
export type McpCallLaunch = {
  /**
   * The step's MCP servers with every ref resolved. A managed connection is
   * already a remote entry pointing at the relay with a `Bearer` header, its
   * URL as the worker host reaches it (no `host.docker.internal` rewrite).
   */
  servers: ResolvedOpenCodeMcpServers;
  /** The step env with each ref's inferred variables (`applyStepMcpEnv`). */
  env: Record<string, string>;
  /**
   * Where a `local` server starts: in the runtime container, from its
   * workspace folder, or on the host, from the checkout.
   */
  placement: McpToolCallPlacement;
};
