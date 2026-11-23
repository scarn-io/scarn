import type {
  McpConnectionPool,
  McpConnectionPoolInput,
  McpPooledToolCall,
} from "../application/mcp-connection-pool";
import type { McpToolCallOutcome } from "../application/mcp-tool-caller";
import type { ResolvedOpenCodeMcpServerConfig } from "../../../common/contracts/opencode-mcp";
import {
  SdkMcpToolCaller,
  type McpCallToolInput,
  type McpConnectInput,
  type McpConnectResult,
} from "./sdk-mcp-tool-caller";

/** What the pool needs of a connection: whether it has died, and how to close it. */
export type PoolableMcpConnection = {
  readonly closed: boolean;
  dispose: () => Promise<void>;
};

/** Opens connections and sends calls over them; {@link SdkMcpToolCaller} in production. */
export interface McpConnector<C extends PoolableMcpConnection> {
  connect(input: McpConnectInput): Promise<McpConnectResult<C>>;
  callTool(connection: C, input: McpCallToolInput): Promise<McpToolCallOutcome>;
}

type Entry<C> = {
  connection: C | null;
  opening: Promise<McpConnectResult<C>> | null;
  opened: boolean;
};

type Interrupted = Extract<
  McpToolCallOutcome,
  { status: "aborted" } | { status: "timeout" }
>;

/**
 * {@link McpConnectionPool} over an {@link McpConnector}.
 *
 * Opening runs under the run's signal rather than the calling step's, so a
 * call that gives up waiting doesn't cancel an opening other calls share; it
 * is bounded by the `timeoutMs` of the call that started it. A connection
 * whose transport closed is disposed and replaced by one new opening the next
 * time its server is called; if that opening fails the call is
 * `unavailable`, and the call after it tries again.
 */
export class SdkMcpConnectionPool<
  C extends PoolableMcpConnection,
> implements McpConnectionPool {
  private readonly entries = new Map<string, Entry<C>>();
  private readonly closing = new AbortController();
  private readonly signal: AbortSignal;
  private closed: Promise<void> | null = null;

  constructor(
    private readonly input: McpConnectionPoolInput,
    private readonly connector: McpConnector<C>,
  ) {
    this.signal = AbortSignal.any([input.signal, this.closing.signal]);
    this.signal.addEventListener("abort", () => void this.closeAll(), {
      once: true,
    });
  }

  async call(
    serverKey: string,
    call: McpPooledToolCall,
  ): Promise<McpToolCallOutcome> {
    const server = this.input.servers[serverKey];
    if (server === undefined) {
      return {
        status: "unavailable",
        reason: "connect",
        detail: `unknown MCP server "${serverKey}"`,
      };
    }
    const signal = AbortSignal.any([call.signal, this.signal]);
    const deadlineAt = Date.now() + call.timeoutMs;
    const interrupted = (): Interrupted | null => {
      if (signal.aborted) return { status: "aborted" };
      if (Date.now() >= deadlineAt) return { status: "timeout" };
      return null;
    };
    const early = interrupted();
    if (early !== null) return early;

    const opened = await raceInterruption(
      this.acquire(serverKey, server, call.timeoutMs),
      signal,
      call.timeoutMs,
    );
    if ("interrupted" in opened) return opened.interrupted;
    if (opened.status !== "connected") return opened;
    const stopped = interrupted();
    if (stopped !== null) return stopped;

    return this.connector.callTool(opened.connection, {
      tool: call.tool,
      args: call.args,
      signal,
      timeoutMs: Math.max(0, deadlineAt - Date.now()),
    });
  }

  closeAll(): Promise<void> {
    this.closed ??= this.disposeAll();
    return this.closed;
  }

  private async disposeAll(): Promise<void> {
    this.closing.abort();
    const entries = [...this.entries.values()];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.opening !== null) await entry.opening;
        await entry.connection?.dispose();
        entry.connection = null;
      }),
    );
  }

  private acquire(
    serverKey: string,
    server: ResolvedOpenCodeMcpServerConfig,
    timeoutMs: number,
  ): Promise<McpConnectResult<C>> {
    let entry = this.entries.get(serverKey);
    if (entry === undefined) {
      entry = { connection: null, opening: null, opened: false };
      this.entries.set(serverKey, entry);
    }
    if (entry.opening !== null) return entry.opening;
    const current = entry.connection;
    if (current !== null && !current.closed) {
      return Promise.resolve({ status: "connected", connection: current });
    }
    if (current !== null) {
      entry.connection = null;
      void current.dispose();
    }
    entry.opening = this.open(serverKey, server, entry, timeoutMs);
    return entry.opening;
  }

  private async open(
    serverKey: string,
    server: ResolvedOpenCodeMcpServerConfig,
    entry: Entry<C>,
    timeoutMs: number,
  ): Promise<McpConnectResult<C>> {
    this.input.onOpen?.({ serverKey, server, reopen: entry.opened });
    entry.opened = true;
    try {
      const result = await this.connector.connect({
        server,
        placement: this.input.placement,
        env: this.input.env,
        timeoutMs,
        signal: this.signal,
      });
      if (result.status !== "connected") return result;
      if (this.signal.aborted) {
        await result.connection.dispose();
        return { status: "aborted" };
      }
      entry.connection = result.connection;
      return result;
    } finally {
      entry.opening = null;
    }
  }
}

/** A pool over a fresh {@link SdkMcpToolCaller}. */
export function createSdkMcpConnectionPool(
  input: McpConnectionPoolInput,
): McpConnectionPool {
  return new SdkMcpConnectionPool(input, new SdkMcpToolCaller());
}

async function raceInterruption<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T | { interrupted: Interrupted }> {
  const controller = new AbortController();
  const interrupted = new Promise<{ interrupted: Interrupted }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ interrupted: { status: "timeout" } });
    }, timeoutMs);
    const onAbort = () => {
      resolve({ interrupted: { status: "aborted" } });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    controller.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    controller.abort();
  }
}
