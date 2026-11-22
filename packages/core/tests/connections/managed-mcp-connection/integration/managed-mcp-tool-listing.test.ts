import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { listManagedMcpTools } from "@/connections/managed-mcp-connection/application/list-managed-mcp-tools";
import { MANAGED_MCP_MAX_TOOL_PAGES } from "@/connections/managed-mcp-connection/infra/sdk-managed-mcp-tool-lister";
import { CoreError } from "@/lib/errors";
import {
  FAKE_MCP_ERROR_MARKER,
  FAKE_MCP_TOOL_OUTPUT_SCHEMA,
} from "tests/connections/support/fake-mcp-server";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const HOUR_MS = 60 * 60 * 1000;

const latestAccessToken = (issued: readonly string[]): string =>
  issued.filter((token) => token.startsWith("fake-access-")).at(-1) ?? "";

const failureOf = async (promise: Promise<object>): Promise<CoreError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
};

/**
 * Listing a managed connection's MCP tools against the loopback fake: the
 * token is refreshed on demand, a 401 forces exactly one refresh and one
 * retry, and every transport failure is a closed-list error with nothing
 * from the server in it.
 */
describe("managed MCP tool listing", () => {
  const harness = createManagedConnectionHarness({
    slowMs: 3_000,
    mcp: { timeoutMs: 1_500 },
  });
  const { fake, clock, appContext } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const ready = async (label: string) => {
    const started = await harness.connectToReady(label);
    return {
      projectId: parseUuidV7(started.projectId),
      connectionId: parseUuidV7(started.connectionId),
    };
  };

  const list = (input: Awaited<ReturnType<typeof ready>>) =>
    listManagedMcpTools(input, appContext);

  const expectProviderUnavailable = (error: CoreError) => {
    expect(error.code).toBe("MANAGED_CONNECTION_PROVIDER_UNAVAILABLE");
    expect(error.status).toBe(502);
    const exposed = JSON.stringify({
      message: error.message,
      meta: error.meta,
    });
    expect(exposed).not.toContain(FAKE_MCP_ERROR_MARKER);
    for (const token of fake.issuedTokens) {
      expect(exposed).not.toContain(token);
    }
  };

  test("lists tools with the stored token and closes the session", async () => {
    const input = await ready("mcp-list");
    const accessToken = fake.issuedTokens[0] ?? "";

    const tools = await list(input);

    expect(tools).toEqual([
      {
        name: "notion-tool-0-0",
        description: "Fake tool 0 on page 0",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        readOnlyHint: true,
      },
      {
        name: "notion-tool-0-1",
        title: "Fake Tool 1",
        description: "Fake tool 1 on page 0",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        outputSchema: FAKE_MCP_TOOL_OUTPUT_SCHEMA,
      },
    ]);
    expect(fake.refreshCount).toBe(0);
    expect(fake.mcp.callsTo("initialize")).toHaveLength(1);
    expect(fake.mcp.callsTo("tools/list")).toHaveLength(1);
    expect(fake.mcp.callsTo("DELETE")).toHaveLength(1);
    expect(fake.mcp.callsTo("DELETE")[0]?.sessionId).toStartWith(
      "fake-session-",
    );
    expect(new Set(fake.mcp.calls.map((call) => call.authorization))).toEqual(
      new Set([`Bearer ${accessToken}`]),
    );
  });

  test("an expired token is refreshed once before listing", async () => {
    const input = await ready("mcp-expired");
    clock.advance(HOUR_MS);

    const tools = await list(input);

    expect(tools).toHaveLength(2);
    expect(fake.refreshCount).toBe(1);
    const refreshed = latestAccessToken(fake.issuedTokens);
    expect(refreshed).not.toBe(fake.issuedTokens[0]);
    expect(new Set(fake.mcp.calls.map((call) => call.authorization))).toEqual(
      new Set([`Bearer ${refreshed}`]),
    );
  });

  test("a 401 forces exactly one refresh and one retry", async () => {
    const input = await ready("mcp-401-once");
    const rejected = fake.issuedTokens[0] ?? "";
    fake.faults.mcp = "mcp_unauthorized_once";

    const tools = await list(input);

    expect(tools).toHaveLength(2);
    expect(fake.refreshCount).toBe(1);
    expect(fake.mcp.callsTo("initialize")).toHaveLength(2);
    expect(fake.mcp.callsTo("initialize")[0]?.authorization).toBe(
      `Bearer ${rejected}`,
    );
    const refreshed = latestAccessToken(fake.issuedTokens);
    expect(refreshed).not.toBe(rejected);
    expect(fake.mcp.callsTo("initialize")[1]?.authorization).toBe(
      `Bearer ${refreshed}`,
    );
  });

  test("a second 401 after the forced refresh is provider-unavailable", async () => {
    const input = await ready("mcp-401-always");
    fake.faults.mcp = "mcp_unauthorized";

    expectProviderUnavailable(await failureOf(list(input)));
    expect(fake.refreshCount).toBe(1);
    expect(fake.mcp.callsTo("initialize")).toHaveLength(2);
  });

  test("a redirect is not followed", async () => {
    const input = await ready("mcp-redirect");
    fake.faults.mcp = "mcp_redirect";
    fake.mcp.redirectTo = `${fake.origin}/elsewhere`;

    expectProviderUnavailable(await failureOf(list(input)));
    expect(fake.calls.filter((call) => call.path === "/elsewhere")).toEqual([]);
    expect(fake.mcp.calls).toHaveLength(1);
    expect(fake.refreshCount).toBe(0);
  });

  test("a response over the cap is provider-unavailable", async () => {
    const input = await ready("mcp-oversize");
    fake.faults.mcp = "mcp_oversize";

    expectProviderUnavailable(await failureOf(list(input)));
    expect(fake.refreshCount).toBe(0);
  });

  test("a server slower than the timeout is provider-unavailable", async () => {
    const input = await ready("mcp-slow");
    fake.faults.mcp = "mcp_slow";

    const startedAt = Date.now();
    expectProviderUnavailable(await failureOf(list(input)));
    expect(Date.now() - startedAt).toBeLessThan(2_900);
    expect(fake.refreshCount).toBe(0);
  });

  test("follows pagination up to the page limit", async () => {
    const input = await ready("mcp-pages");
    fake.mcp.toolPages = MANAGED_MCP_MAX_TOOL_PAGES;

    const tools = await list(input);

    expect(tools).toHaveLength(2 * MANAGED_MCP_MAX_TOOL_PAGES);
    expect(tools.at(-1)?.name).toBe(
      `notion-tool-${String(MANAGED_MCP_MAX_TOOL_PAGES - 1)}-1`,
    );
    expect(fake.mcp.callsTo("tools/list")).toHaveLength(
      MANAGED_MCP_MAX_TOOL_PAGES,
    );
  });

  test("a server that keeps paginating past the limit fails without looping", async () => {
    const input = await ready("mcp-too-many-pages");
    fake.mcp.toolPages = 1_000;

    expectProviderUnavailable(await failureOf(list(input)));
    expect(fake.mcp.callsTo("tools/list")).toHaveLength(
      MANAGED_MCP_MAX_TOOL_PAGES,
    );
    expect(fake.mcp.callsTo("DELETE")).toHaveLength(1);
  });
});
