/**
 * The relay a run's agent calls with its relay capability: admitted calls
 * reach the fake Notion MCP with the server's access token and stream back
 * unchanged; refused calls never reach it.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { isServingManagedConnection } from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import {
  mcpSessionIdDigest,
  relayCapabilityDigest,
} from "@/connections/managed-mcp-connection/domain/managed-launch-digests";
import { getDb } from "@/lib/db";
import {
  FAKE_MCP_ECHO_BEARER_TOOL,
  FAKE_MCP_ERROR_MARKER,
} from "tests/connections/support/fake-mcp-server";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import {
  createRelayTestClient,
  RELAY_PROTOCOL_VERSION,
  rpc,
} from "./managed-mcp-relay-test-support";

describe("POST|DELETE /mcp-relay/:launchConnectionId", () => {
  const harness = createManagedConnectionHarness();
  const { apiClient, fake, appContext, clock } = harness;

  afterEach(async () => {
    await harness.settleBackgroundTasks();
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const { register, launch, relay, initialize } =
    createRelayTestClient(harness);

  const storedLaunch = (capability: string) =>
    appContext.managedLaunchRepo.loadByCapabilityDigest(
      relayCapabilityDigest(capability),
    );

  const openOperations = (taskRunId: UuidV7) =>
    appContext.managedLaunchRepo.listOperations(taskRunId, getDb());

  const expectRefused = async (
    response: Response,
    status: number,
    code: string,
  ) => {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(fake.mcp.calls).toHaveLength(0);
  };

  test("initialize, tools/list and tools/call pass through, and the session is bound", async () => {
    const target = await launch("relay-happy");

    const sessionId = await initialize(target);
    const session = { "mcp-session-id": sessionId };
    const listed = await relay(target, {
      headers: session,
      body: rpc(2, "tools/list"),
    });
    const called = await relay(target, {
      headers: session,
      body: rpc(3, "tools/call", {
        name: "notion-tool-0-0",
        arguments: { query: "x" },
      }),
    });

    expect(listed.status).toBe(200);
    expect(listed.headers.get("content-type")).toBe("application/json");
    expect(
      ((await listed.json()) as { result: { tools: unknown[] } }).result.tools,
    ).toHaveLength(2);
    expect(called.status).toBe(200);
    expect(await called.json()).toMatchObject({
      id: 3,
      result: { content: [{ type: "text", text: "called notion-tool-0-0" }] },
    });
    expect(fake.mcp.effectCount("notion-tool-0-0")).toBe(1);
    expect(fake.mcp.callsTo("tools/call")[0]?.sessionId).toBe(sessionId);
    expect((await storedLaunch(target.capability))?.mcpSessionIdDigest).toEqual(
      mcpSessionIdDigest(sessionId),
    );
  });

  test("the operation row is gone once a call completes", async () => {
    const target = await launch("relay-operation");

    await initialize(target);
    await harness.settleBackgroundTasks();

    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("DELETE ends the session upstream", async () => {
    const target = await launch("relay-delete");
    const sessionId = await initialize(target);
    expect(fake.mcp.openSessions.has(sessionId)).toBe(true);

    const response = await relay(target, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(fake.mcp.callsTo("DELETE")).toHaveLength(1);
    expect(fake.mcp.openSessions.has(sessionId)).toBe(false);
  });

  test("a session id this launch didn't bind is 404, with nothing sent", async () => {
    const victim = await launch("relay-victim");
    const stolen = await initialize(victim);
    const thief = await launch("relay-thief");

    await expectRefused(
      await relay(thief, {
        headers: { "mcp-session-id": stolen },
        body: rpc(2, "tools/list"),
      }),
      404,
      "MANAGED_MCP_SESSION_NOT_FOUND",
    );
  });

  test("a second initialize rebinds the launch to the new session, and the old one is 404", async () => {
    const target = await launch("relay-reinitialize");
    const first = await initialize(target);
    const second = await initialize(target);

    const listed = await relay(target, {
      headers: { "mcp-session-id": second },
      body: rpc(2, "tools/list"),
    });
    const stale = await relay(target, {
      headers: { "mcp-session-id": first },
      body: rpc(3, "tools/list"),
    });

    expect(second).not.toBe(first);
    expect(listed.status).toBe(200);
    await listed.text();
    expect(stale.status).toBe(404);
    expect(await stale.json()).toMatchObject({
      code: "MANAGED_MCP_SESSION_NOT_FOUND",
    });
    expect(fake.mcp.callsTo("tools/list")).toHaveLength(1);
    expect((await storedLaunch(target.capability))?.mcpSessionIdDigest).toEqual(
      mcpSessionIdDigest(second),
    );
  });

  test("a rotated-away capability is 401", async () => {
    const target = await launch("relay-rotated");
    await register(target.owner, target.taskRunId, target.claimToken);
    fake.mcp.calls.length = 0;

    await expectRefused(
      await relay(target, { body: rpc(1, "tools/list") }),
      401,
      "MANAGED_RELAY_UNAUTHORIZED",
    );
  });

  test("a capability used on another launch's URL is 401", async () => {
    const first = await launch("relay-url-a");
    const second = await launch("relay-url-b");

    await expectRefused(
      await relay(
        { relayUrl: second.relayUrl, capability: first.capability },
        { body: rpc(1, "tools/list") },
      ),
      401,
      "MANAGED_RELAY_UNAUTHORIZED",
    );
  });

  test("a closed launch is refused with no dispatch", async () => {
    const target = await launch("relay-closed");
    await appContext.managedLaunchRepo.closeAllForRun(
      target.taskRunId,
      new Date(),
      getDb(),
    );

    await expectRefused(
      await relay(target, { body: rpc(1, "tools/list") }),
      409,
      "MANAGED_LAUNCH_NOT_ACTIVE",
    );
  });

  test("a run that is no longer running is refused with no dispatch", async () => {
    const target = await launch("relay-completed");
    await unwrapAsync(
      apiClient.api["task-runs"]({
        taskRunId: target.taskRunId,
      }).completions.post(
        {
          claimToken: target.claimToken,
          status: "succeeded",
          resultJson: { ok: true },
          errorJson: null,
        },
        { headers: target.owner.authHeaders },
      ),
    );

    await expectRefused(
      await relay(target, { body: rpc(1, "tools/list") }),
      409,
      "MANAGED_LAUNCH_NOT_ACTIVE",
    );
  }, 30_000);

  test("a lapsed lease is refused with no dispatch", async () => {
    const target = await launch("relay-lapsed");
    clock.advance(61_000);

    await expectRefused(
      await relay(target, { body: rpc(1, "tools/list") }),
      409,
      "MANAGED_LAUNCH_NOT_ACTIVE",
    );
  });

  test("a connection that lost its authority is refused with the reason", async () => {
    const target = await launch("relay-authority");
    const stored = await storedLaunch(target.capability);
    if (!stored) {
      throw new Error("expected a stored launch");
    }
    const connection = await appContext.managedConnectionRepo.findById(
      stored.projectId,
      stored.connectionId,
    );
    if (!connection || !isServingManagedConnection(connection)) {
      throw new Error("expected a serving connection");
    }
    await appContext.managedConnectionRepo.saveIfVersion(
      connection.requireReconnect("refresh_failed", new Date()),
      connection.version,
    );

    const response = await relay(target, { body: rpc(1, "tools/list") });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "MANAGED_CONNECTION_AUTHORITY_LOST",
      meta: { reason: "reconnect_required" },
    });
    expect(fake.mcp.calls).toHaveLength(0);
  });

  test("caller cookies, forwarding headers and authorization never reach the provider", async () => {
    const target = await launch("relay-headers");

    const response = await relay(target, {
      headers: {
        cookie: "better-auth.session_token=secret",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-host": "evil.test",
        "x-custom": "nope",
      },
      body: rpc(1, "tools/list"),
    });

    expect(response.status).toBe(200);
    await response.text();
    const [call] = fake.mcp.calls;
    const received = [...(call?.headers.keys() ?? [])];
    expect(received).not.toContain("cookie");
    expect(received).not.toContain("x-custom");
    expect(received.filter((name) => name.startsWith("x-forwarded"))).toEqual(
      [],
    );
    expect(call?.authorization).toStartWith("Bearer fake-access-");
    expect(call?.authorization).not.toContain(target.capability);
    expect(call?.headers.get("mcp-protocol-version")).toBe(
      RELAY_PROTOCOL_VERSION,
    );
  });

  test("a query string is 400 with no dispatch", async () => {
    const target = await launch("relay-query");

    await expectRefused(
      await relay(target, {
        url: `${target.relayUrl}?x=1`,
        body: rpc(1, "tools/list"),
      }),
      400,
      "MANAGED_RELAY_QUERY_NOT_ALLOWED",
    );
  });

  test("an Origin header is 400 with no dispatch", async () => {
    const target = await launch("relay-origin");

    await expectRefused(
      await relay(target, {
        headers: { origin: "https://evil.test" },
        body: rpc(1, "tools/list"),
      }),
      400,
      "MANAGED_RELAY_ORIGIN_NOT_ALLOWED",
    );
  });

  test("GET is 405 with no dispatch", async () => {
    const target = await launch("relay-get");

    await expectRefused(
      await relay(target, { method: "GET" }),
      405,
      "METHOD_NOT_ALLOWED",
    );
  });

  test("a body one byte over 64 KiB is 413 with no dispatch", async () => {
    const target = await launch("relay-oversize");

    await expectRefused(
      await relay(target, { body: "x".repeat(64 * 1024 + 1) }),
      413,
      "MANAGED_RELAY_BODY_TOO_LARGE",
    );
    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("a provider 500 body never reaches the caller", async () => {
    const target = await launch("relay-500");
    fake.faults.mcp = "mcp_server_error";

    const response = await relay(target, { body: rpc(1, "tools/list") });

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain(FAKE_MCP_ERROR_MARKER);
    expect(JSON.parse(body)).toMatchObject({
      code: "MANAGED_PROVIDER_ERROR",
      meta: { providerStatusClass: "5xx" },
    });
    expect(fake.mcp.calls).toHaveLength(1);
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("an upstream 401 gets one refresh and one resend", async () => {
    const target = await launch("relay-401");
    fake.faults.mcp = "mcp_unauthorized_once";

    const response = await relay(target, {
      body: rpc(1, "tools/call", { name: "notion-tool-0-0", arguments: {} }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1 });
    expect(fake.refreshCount).toBe(1);
    const [rejected, resent] = fake.mcp.callsTo("tools/call");
    expect(fake.mcp.callsTo("tools/call")).toHaveLength(2);
    expect(resent?.authorization).not.toBe(rejected?.authorization);
    expect(fake.mcp.effectCount("notion-tool-0-0")).toBe(1);
  });

  test("an HTTP-200 body that echoes the bearer reaches the caller unchanged", async () => {
    const target = await launch("relay-echo");

    const response = await relay(target, {
      body: rpc(1, "tools/call", {
        name: FAKE_MCP_ECHO_BEARER_TOOL,
        arguments: {},
      }),
    });

    expect(response.status).toBe(200);
    const bearer = fake.mcp.callsTo("tools/call")[0]?.authorization ?? "";
    expect(bearer).toStartWith("Bearer fake-access-");
    expect(await response.json()).toMatchObject({
      result: { content: [{ type: "text", text: bearer }] },
    });
  });
});
