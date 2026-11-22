/**
 * The relay's time limits: a call is cut at its total limit or when the
 * provider goes idle, its operation row is deleted, and a row whose cleanup
 * never ran is left with a deadline past the call's limit plus grace. A call
 * waits out another caller's refresh for a bounded time.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  MANAGED_OPERATION_DEADLINE_GRACE_MS,
  relayManagedMcpCall,
} from "@/connections/managed-mcp-connection/application/relay-managed-mcp-call";
import { relayCapabilityDigest } from "@/connections/managed-mcp-connection/domain/managed-launch-digests";
import { getDb } from "@/lib/db";
import { CoreError } from "@/lib/errors";
import {
  FAKE_MCP_STREAM_TOOL,
  type StreamToolArguments,
} from "tests/connections/support/fake-mcp-server";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import {
  createRelayTestClient,
  RELAY_PROTOCOL_VERSION,
  rpc,
  type RelayLaunch,
} from "./managed-mcp-relay-test-support";

const CALL_TIMEOUT_MS = 800;
const IDLE_TIMEOUT_MS = 300;
const REFRESH_BUSY_WAIT_MS = 600;

const decoder = new TextDecoder();

const failed = <T>(promise: Promise<T>): Promise<boolean> =>
  promise.then(
    () => false,
    () => true,
  );

const drain = async (response: Response): Promise<void> => {
  await response.text();
};

describe("relay limits", () => {
  const harness = createManagedConnectionHarness({
    relay: { callTimeoutMs: CALL_TIMEOUT_MS, idleTimeoutMs: IDLE_TIMEOUT_MS },
  });
  const { fake, appContext, clock } = harness;

  afterEach(async () => {
    await harness.settleBackgroundTasks();
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const { launch, relay } = createRelayTestClient(harness);

  const openOperations = (taskRunId: UuidV7) =>
    appContext.managedLaunchRepo.listOperations(taskRunId, getDb());

  const callStreamTool = (target: RelayLaunch, args: StreamToolArguments) =>
    relay(target, {
      body: rpc(7, "tools/call", {
        name: FAKE_MCP_STREAM_TOOL,
        arguments: args,
      }),
    });

  test("a stream still running at the call limit is cut and its operation deleted", async () => {
    const target = await launch("relay-call-limit");
    const startedAt = Date.now();

    const response = await callStreamTool(target, {
      events: 1_000,
      intervalMs: IDLE_TIMEOUT_MS / 3,
    });

    expect(response.status).toBe(200);
    expect(await failed(drain(response))).toBe(true);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(CALL_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(CALL_TIMEOUT_MS + 1_000);
    const [upstream] = fake.mcp.callsTo("tools/call");
    await upstream?.aborted;
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("a provider that sends headers and then stalls is cut at the idle limit", async () => {
    const target = await launch("relay-idle-limit");
    const startedAt = Date.now();

    const response = await callStreamTool(target, { events: 1, hang: true });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("expected a response body");
    }
    expect(decoder.decode((await reader.read()).value)).toContain(
      "notifications/progress",
    );
    expect(await failed(reader.read())).toBe(true);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(CALL_TIMEOUT_MS);
    await fake.mcp.callsTo("tools/call")[0]?.aborted;
    await harness.settleBackgroundTasks();
    expect(await openOperations(target.taskRunId)).toEqual([]);
  });

  test("a skipped cleanup leaves the operation, due at the call limit plus grace", async () => {
    const target = await launch("relay-skipped-cleanup");
    const skipped = spyOn(
      appContext.managedLaunchRepo,
      "deleteOperation",
    ).mockImplementation(() => Promise.resolve());
    try {
      const response = await relay(target, { body: rpc(1, "tools/list") });
      expect(response.status).toBe(200);
      await drain(response);
      await harness.settleBackgroundTasks();
      expect(skipped).toHaveBeenCalledTimes(1);
    } finally {
      skipped.mockRestore();
    }

    const [left] = await openOperations(target.taskRunId);
    if (!left) {
      throw new Error("expected the operation to be left");
    }
    expect(left.deadlineAt.getTime() - left.startedAt.getTime()).toBe(
      CALL_TIMEOUT_MS + MANAGED_OPERATION_DEADLINE_GRACE_MS,
    );
    expect(left.deadlineAt.getTime()).toBeGreaterThan(clock.now().getTime());
    clock.advance(CALL_TIMEOUT_MS + MANAGED_OPERATION_DEADLINE_GRACE_MS);
    expect(left.deadlineAt.getTime()).toBeLessThan(clock.now().getTime());
    await appContext.managedLaunchRepo.deleteOperation(left.id);
  });

  describe("while another caller holds the refresh claim", () => {
    const servingGrant = async (target: RelayLaunch) => {
      const stored = await appContext.managedLaunchRepo.loadByCapabilityDigest(
        relayCapabilityDigest(target.capability),
      );
      const grant =
        stored &&
        (await appContext.managedOAuthGrantRepo.findById(
          stored.projectId,
          stored.connectionId,
          stored.grantId,
        ));
      if (!grant) {
        throw new Error("expected the launch's grant");
      }
      return grant;
    };

    const holdRefreshClaim = async (target: RelayLaunch) => {
      const claimId = createUuidV7();
      await appContext.managedOAuthGrantRepo.save(
        (await servingGrant(target)).claimRefresh(claimId, clock.now()),
      );
      return async () => {
        await appContext.managedOAuthGrantRepo.save(
          (await servingGrant(target)).releaseClaim(claimId, clock.now()),
        );
      };
    };

    const relayDirect = (target: RelayLaunch) => {
      const background: Promise<unknown>[] = [];
      const call = relayManagedMcpCall(
        {
          launchConnectionId: target.relayUrl.split("/").at(-1) ?? "",
          request: new Request(target.relayUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${target.capability}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": RELAY_PROTOCOL_VERSION,
            },
            body: JSON.stringify(rpc(1, "tools/list")),
          }),
        },
        {
          ...appContext,
          runAfterResponse: (task) => {
            background.push(task);
          },
          refreshBusyWaitMs: REFRESH_BUSY_WAIT_MS,
        },
      );
      return { call, settled: () => Promise.allSettled(background) };
    };

    test("a claim that outlasts the busy wait is 503 with no dispatch", async () => {
      const target = await launch("relay-refresh-busy");
      const release = await holdRefreshClaim(target);
      const startedAt = Date.now();

      let error: CoreError | null = null;
      try {
        await relayDirect(target).call;
      } catch (thrown) {
        if (!(thrown instanceof CoreError)) {
          throw thrown;
        }
        error = thrown;
      }

      expect(error).toBeInstanceOf(CoreError);
      expect(error).toMatchObject({
        code: "MANAGED_CONNECTION_REFRESH_BUSY",
        status: 503,
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        REFRESH_BUSY_WAIT_MS - 50,
      );
      expect(fake.mcp.calls).toHaveLength(0);
      expect(await openOperations(target.taskRunId)).toEqual([]);
      await release();
    });

    test("a claim that clears within the busy wait lets the call through", async () => {
      const target = await launch("relay-refresh-clears");
      const release = await holdRefreshClaim(target);

      const { call, settled } = relayDirect(target);
      await Bun.sleep(REFRESH_BUSY_WAIT_MS / 3);
      await release();
      const response = await call;

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 1 });
      expect(fake.mcp.callsTo("tools/list")).toHaveLength(1);
      await settled();
      expect(await openOperations(target.taskRunId)).toEqual([]);
    });
  });
});
