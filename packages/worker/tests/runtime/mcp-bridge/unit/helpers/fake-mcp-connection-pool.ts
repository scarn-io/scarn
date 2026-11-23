/**
 * A scripted {@link McpConnectionPool} for bridge tests: records every call
 * and answers with `respond`, which may wait on the call's signal.
 */
import type {
  McpConnectionPool,
  McpConnectionPoolFactory,
  McpConnectionPoolInput,
  McpPooledToolCall,
} from "../../../../../src/work/task-run/application/mcp-connection-pool";
import type { McpToolCallOutcome } from "../../../../../src/work/task-run/application/mcp-tool-caller";

export type FakePoolCall = McpPooledToolCall & { serverKey: string };

export type FakePool = {
  factory: McpConnectionPoolFactory;
  calls: FakePoolCall[];
  input(): McpConnectionPoolInput;
  closeAllCount(): number;
};

export function createFakePool(
  respond: (call: FakePoolCall) => Promise<McpToolCallOutcome>,
): FakePool {
  const calls: FakePoolCall[] = [];
  let input: McpConnectionPoolInput | null = null;
  let closeAllCount = 0;
  const opened = new Set<string>();
  const factory: McpConnectionPoolFactory = (poolInput) => {
    input = poolInput;
    const pool: McpConnectionPool = {
      call(serverKey, call) {
        const server = poolInput.servers[serverKey];
        if (server && !opened.has(serverKey)) {
          opened.add(serverKey);
          poolInput.onOpen?.({ serverKey, server, reopen: false });
        }
        const recorded = { ...call, serverKey };
        calls.push(recorded);
        return respond(recorded);
      },
      closeAll() {
        closeAllCount += 1;
        return Promise.resolve();
      },
    };
    return pool;
  };
  return {
    factory,
    calls,
    input: () => {
      if (input === null) throw new Error("pool not created");
      return input;
    },
    closeAllCount: () => closeAllCount,
  };
}

/** Resolves `aborted` once `signal` aborts. */
export function untilAborted(signal: AbortSignal): Promise<McpToolCallOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ status: "aborted" });
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve({ status: "aborted" });
      },
      { once: true },
    );
  });
}
