/**
 * Fake `context.mcp` clients for unit-testing a code step's `fn` without a
 * Scarn run (ADR 0016). `createFakeMcpClients(handles, fakes)` returns an
 * `McpClients` typed from the same catalogs, whose calls go to the given
 * fake functions instead of the worker's MCP bridge.
 *
 * Arguments and results go through the same validation as the real client:
 * a fake for a tool with an `output` schema returns that output, and one for
 * a tool without returns an MCP content result. A fake may throw any MCP
 * error class to exercise an error path. Calling a tool with no fake throws
 * `McpUnavailableError`.
 *
 * The untyped `call(toolName, args)` always goes to the server's `call` fake,
 * which returns an MCP content result.
 */
import type { McpToolContentResult } from "../../pipelines/types";
import type { McpTool } from "../mcp-tools/catalog";
import {
  buildMcpClients,
  type McpClients,
  type McpHandleToolsOf,
  type McpInvocation,
} from "./code-step-mcp-client";
import type { McpHandle } from "./define-mcp";
import { McpUnavailableError } from "./mcp-errors";
import type { McpToolStepResult } from "./define-mcp-tool-step";

/** A fake for one catalog tool: it gets the parsed arguments. */
export type FakeMcpTool<TTool extends McpTool> = (
  args: TTool["input"]["_output"],
) => Promise<McpToolStepResult<TTool>> | McpToolStepResult<TTool>;

/** A fake for the untyped `call` escape hatch. */
export type FakeMcpCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<McpToolContentResult> | McpToolContentResult;

/** The fakes for one server: any of its catalog tools, plus an optional `call` fake. */
export type FakeMcpClient<THandle extends McpHandle> = FakeMcpTools<
  McpHandleToolsOf<THandle>
> & { readonly call?: FakeMcpCall };

type FakeMcpTools<TTools extends Record<string, McpTool>> = {
  readonly [K in keyof TTools as K extends "call" ? never : K]?: FakeMcpTool<
    TTools[K]
  >;
};

/** The fakes for a step's `mcps`; servers and tools left out have none. */
export type FakeMcpClients<TMcps extends Record<string, McpHandle>> = {
  readonly [K in keyof TMcps]?: FakeMcpClient<TMcps[K]>;
};

type AnyFake = (...args: unknown[]) => unknown;

function missingFake(call: McpInvocation, faked: string): McpUnavailableError {
  return new McpUnavailableError(
    `MCP tool ${call.server}.${call.toolName} has no fake. Add ${call.server}.${faked} to createFakeMcpClients(...).`,
    "no_fake",
    `no fake for ${call.server}.${faked}`,
  );
}

/**
 * Fake `context.mcp` clients for a code step's `mcps`, for unit tests:
 * `fn(input, { artifactsDir, mcp: createFakeMcpClients({ notion }, { notion: { search: async (args) => … } }) })`.
 */
export function createFakeMcpClients<TMcps extends Record<string, McpHandle>>(
  handles: TMcps,
  fakes: FakeMcpClients<TMcps> = {},
): McpClients<TMcps> {
  const fakeFor = (server: string, key: string): AnyFake | undefined => {
    const serverFakes = (
      fakes as Record<string, Record<string, unknown> | undefined>
    )[server];
    const fake = serverFakes?.[key];
    return typeof fake === "function" ? (fake as AnyFake) : undefined;
  };

  return buildMcpClients(handles, async (call) => {
    if (call.catalogKey !== undefined) {
      const fake = fakeFor(call.server, call.catalogKey);
      if (fake === undefined) throw missingFake(call, call.catalogKey);
      const value = await fake(call.args);
      return { kind: "value", value };
    }
    const callFake = fakeFor(call.server, "call");
    if (callFake === undefined) throw missingFake(call, "call");
    const value = await callFake(call.toolName, call.args);
    return { kind: "value", value };
  });
}
