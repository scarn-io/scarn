/**
 * The relay's streaming behaviour: 2xx bodies stream through as the
 * provider produces them and only as fast as the caller reads, a caller's
 * abort reaches the provider, and in-flight calls are bounded per launch.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { relayCapabilityDigest } from "@/connections/managed-mcp-connection/domain/managed-launch-digests";
import { getDb } from "@/lib/db";
import { managedOAuthGrants } from "@/lib/db/schema";
import {
  FAKE_MCP_SLOW_TOOL,
  FAKE_MCP_STREAM_TOOL,
  type StreamToolArguments,
} from "tests/connections/support/fake-mcp-server";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import {
  createRelayTestClient,
  rpc,
  type RelayLaunch,
} from "./managed-mcp-relay-test-support";

const waitFor = async (condition: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(5);
  }
};

const decoder = new TextDecoder();

const failed = <T>(promise: Promise<T>): Promise<boolean> =>
  promise.then(
    () => false,
    () => true,
  );

const readerOf = (response: Response) => {
  if (!response.body) {
    throw new Error("expected a response body");
  }
  return response.body.getReader();
};

const readChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> => {
  const { done, value } = await reader.read();
  if (done) {
    throw new Error("expected another chunk");
  }
  return decoder.decode(value);
};

const readRest = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> => {
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    text += decoder.decode(value);
  }
};

describe("relay streaming", () => {
  const harness = createManagedConnectionHarness();
  const { fake, appContext } = harness;

  afterEach(async () => {
    await harness.settleBackgroundTasks();
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const { launch, relay, initialize } = createRelayTestClient(harness);

  const openOperations = (taskRunId: UuidV7) =>
    appContext.managedLaunchRepo.listOperations(taskRunId, getDb());

  /**
   * The provider's pull count once the buffers between it and a stalled
   * caller have filled: the count holds steady for 300ms. A loaded machine
   * can take a while to fill them, so a fixed sleep is not enough.
   */
  const pullsOnceBuffersFill = async () => {
    const deadline = Date.now() + 5_000;
    let previous = -1;
    while (fake.mcp.streamPulls !== previous) {
      if (Date.now() > deadline) {
        throw new Error("the relay never stopped pulling from the provider");
      }
      previous = fake.mcp.streamPulls;
      await Bun.sleep(300);
    }
    return previous;
  };

  const callStreamTool = (
    target: RelayLaunch,
    args: StreamToolArguments,
    signal?: AbortSignal,
  ) =>
    relay(target, {
      body: rpc(7, "tools/call", {
        name: FAKE_MCP_STREAM_TOOL,
        arguments: args,
      }),
      ...(signal ? { signal } : {}),
    });

  test("an SSE response reaches the caller chunk by chunk, before the provider has finished", async () => {
    const target = await launch("relay-sse-chunks");

    const response = await callStreamTool(target, {
      events: 5,
      intervalMs: 100,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = readerOf(response);
    const first = await readChunk(reader);
    expect(first).toContain("notifications/progress");
    expect(fake.mcp.streamPulls).toBeLessThan(5);
    const rest = await readRest(reader);
    expect(`${first}${rest}`.match(/notifications\/progress/gu)).toHaveLength(
      5,
    );
    expect(rest).toContain('"text":"streamed"');
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("a caller that stops reading stops the relay pulling from the provider", async () => {
    const target = await launch("relay-sse-backpressure");
    const events = 1000;

    const response = await callStreamTool(target, {
      events,
      padBytes: 16 * 1024,
    });
    const reader = readerOf(response);
    try {
      await readChunk(reader);
      const pulledWhileStalled = await pullsOnceBuffersFill();

      expect(pulledWhileStalled).toBeLessThan(events / 2);
    } finally {
      await reader.cancel();
    }
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("notifications/initialized and notifications/cancelled are forwarded and answered 202", async () => {
    const target = await launch("relay-notifications");
    const sessionId = await initialize(target);
    const session = { "mcp-session-id": sessionId };

    const initialized = await relay(target, {
      headers: session,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    const cancelled = await relay(target, {
      headers: session,
      body: {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "agent gave up" },
      },
    });

    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe("");
    expect(cancelled.status).toBe(202);
    expect(await cancelled.text()).toBe("");
    expect(fake.mcp.callsTo("notifications/initialized")).toHaveLength(1);
    const [forwarded] = fake.mcp.callsTo("notifications/cancelled");
    expect(forwarded?.sessionId).toBe(sessionId);
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("a provider redirect is refused and its target receives nothing", async () => {
    const target = await launch("relay-redirect");
    let redirectHits = 0;
    const elsewhere = Bun.serve({
      port: 0,
      fetch: () => {
        redirectHits += 1;
        return new Response("followed");
      },
    });
    try {
      fake.faults.mcp = "mcp_redirect";
      fake.mcp.redirectTo = `http://127.0.0.1:${String(elsewhere.port)}/mcp`;

      const response = await relay(target, { body: rpc(1, "tools/list") });

      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).not.toContain("followed");
      expect(JSON.parse(body)).toMatchObject({
        code: "MANAGED_PROVIDER_UNAVAILABLE",
      });
      expect(fake.mcp.calls).toHaveLength(1);
      expect(redirectHits).toBe(0);
      expect(await openOperations(target.taskRunId)).toEqual([]);
    } finally {
      await elsewhere.stop(true);
    }
  });

  test("a ninth concurrent call is 429 with no dispatch, and a call succeeds once they finish", async () => {
    const target = await launch("relay-concurrency");
    fake.mcp.slowToolMs = 1_000;
    const slowCall = (id: number) =>
      relay(target, {
        body: rpc(id, "tools/call", {
          name: FAKE_MCP_SLOW_TOOL,
          arguments: {},
        }),
      });

    const inFlight = Array.from({ length: 8 }, (_, index) =>
      slowCall(index + 1),
    );
    await waitFor(() => fake.mcp.effectCount(FAKE_MCP_SLOW_TOOL) === 8);
    const ninth = await slowCall(9);

    expect(ninth.status).toBe(429);
    expect(await ninth.json()).toMatchObject({
      code: "MANAGED_RELAY_TOO_MANY_OPERATIONS",
    });
    expect(fake.mcp.callsTo("tools/call")).toHaveLength(8);
    expect(await openOperations(target.taskRunId)).toHaveLength(8);

    for (const response of await Promise.all(inFlight)) {
      expect(response.status).toBe(200);
      await response.text();
    }
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
    const next = await relay(target, { body: rpc(10, "tools/list") });
    expect(next.status).toBe(200);
    await next.text();
  }, 20_000);

  test("disconnect during a stream drops the ciphertext at once; the stream finishes and the next call is 409", async () => {
    const target = await launch("relay-disconnect");
    const stored = await appContext.managedLaunchRepo.loadByCapabilityDigest(
      relayCapabilityDigest(target.capability),
    );
    if (!stored) {
      throw new Error("expected a stored launch");
    }
    const response = await callStreamTool(target, {
      events: 4,
      intervalMs: 150,
    });
    const reader = readerOf(response);
    const first = await readChunk(reader);

    await harness.disconnect(
      target.owner,
      stored.projectId,
      stored.connectionId,
    );

    const grants = await getDb()
      .select({ ciphertext: managedOAuthGrants.credentialsCiphertext })
      .from(managedOAuthGrants)
      .where(eq(managedOAuthGrants.connectionId, stored.connectionId));
    expect(grants.map((grant) => grant.ciphertext)).toEqual([null]);
    const rest = await readRest(reader);
    expect(`${first}${rest}`).toContain('"text":"streamed"');
    const dispatched = fake.mcp.calls.length;

    const next = await relay(target, { body: rpc(8, "tools/list") });

    expect(next.status).toBe(409);
    expect(await next.json()).toMatchObject({
      code: "MANAGED_CONNECTION_AUTHORITY_LOST",
      meta: { reason: "disconnected" },
    });
    expect(fake.mcp.calls).toHaveLength(dispatched);
  });

  test("a caller abort mid-stream aborts the upstream request and deletes the operation", async () => {
    const target = await launch("relay-abort");
    const caller = new AbortController();

    const response = await callStreamTool(
      target,
      { events: 100, intervalMs: 50 },
      caller.signal,
    );
    const reader = readerOf(response);
    await readChunk(reader);
    const [upstream] = fake.mcp.callsTo("tools/call");
    if (!upstream) {
      throw new Error("expected the call upstream");
    }

    caller.abort();

    await upstream.aborted;
    expect(await failed(readRest(reader))).toBe(true);
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
    expect(fake.mcp.streamPulls).toBeLessThan(100);
  });
});
