/**
 * A worker registers its launch with the claim token and gets one relay
 * entry per connection-auth MCP server in the run's own config. Each entry
 * pins the connection's generation and grant; only the capability's digest
 * is stored.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { isServingManagedConnection } from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import { relayCapabilityDigest } from "@/connections/managed-mcp-connection/domain/managed-launch-digests";
import { getDb } from "@/lib/db";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import {
  createManagedConnectionHarness,
  MANAGED_CONNECTION_APP_URL,
} from "./managed-connection-test-support";
import {
  createLaunchTestClient,
  notionRef,
} from "./register-managed-launch-test-support";

describe("POST /task-runs/:taskRunId/managed-launch", () => {
  const harness = createManagedConnectionHarness();
  const { apiClient, fake, appContext } = harness;

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const { startAndClaim, register } = createLaunchTestClient(harness);

  const launchByCapability = (capability: string) =>
    appContext.managedLaunchRepo.loadByCapabilityDigest(
      relayCapabilityDigest(capability),
    );

  test("a run whose step references a ready connection gets one entry", async () => {
    const { owner, projectId, connectionId, ready } =
      await harness.connectToReady("launch-ready");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );

    const launch = await unwrapAsync(register(owner, taskRunId, claimToken));

    expect(Object.keys(launch.entries)).toEqual(["notion"]);
    const entry = launch.entries["notion"];
    if (!entry) {
      throw new Error("expected a notion entry");
    }
    const stored = await launchByCapability(entry.capability);
    expect(stored).toMatchObject({
      projectId,
      taskRunId,
      entryKey: "notion",
      connectionId,
      generation: ready.generation,
      state: "open",
      mcpSessionIdDigest: null,
    });
    expect(entry.relayUrl).toBe(
      `${MANAGED_CONNECTION_APP_URL}/api/mcp-relay/${stored?.id ?? ""}`,
    );
    expect(entry.capability).toMatch(/^[\w-]{43}$/u);
    expect(
      (
        await appContext.managedConnectionEventRepo.listByConnection(
          projectId,
          connectionId,
        )
      ).some(
        (event) =>
          event.type === "launch_registered" && event.taskRunId === taskRunId,
      ),
    ).toBe(true);
  });

  test("a run with no connection-auth entry gets no entries", async () => {
    const { owner, projectId } = await harness.connectToReady("launch-none");
    const { taskRunId, claimToken } = await startAndClaim(owner, projectId, {
      plain: { type: "remote", url: "https://example.test/mcp" },
    });

    expect(
      await unwrapAsync(
        register(owner, taskRunId, claimToken, {
          entries: {},
          remotesWithoutAuth: { plain: { url: "https://example.test/mcp" } },
        }),
      ),
    ).toEqual({ entries: {} });
  });

  test("a connection that needs reconnecting fails with its state and reason", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("launch-reconnect");
    const connection = await appContext.managedConnectionRepo.findById(
      projectId,
      parseUuidV7(connectionId),
    );
    if (!connection || !isServingManagedConnection(connection)) {
      throw new Error("expected a serving connection");
    }
    expect(
      await appContext.managedConnectionRepo.saveIfVersion(
        connection.requireReconnect("refresh_failed", new Date()),
        connection.version,
      ),
    ).toBe(true);
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );

    const { data, error } = await register(owner, taskRunId, claimToken);

    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: {
        state: "reconnect_required",
        reasonCode: "refresh_failed",
        key: "notion",
        connection: "notion",
        label: "Notion",
      },
      detail:
        'The Notion connection ("notion") that MCP server "notion" uses is not ready: a project admin must reconnect it',
    });
    expect(
      await appContext.managedLaunchRepo.listOpenForRun(taskRunId, getDb()),
    ).toEqual([]);
  });

  test("a wrong claim token is refused", async () => {
    const { owner, projectId } = await harness.connectToReady("launch-claim");
    const { taskRunId } = await startAndClaim(owner, projectId, notionRef);

    const { data, error } = await register(owner, taskRunId, "not-the-claim");

    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "TASK_OWNERSHIP_CONFLICT" });
    expect(
      await appContext.managedLaunchRepo.listOpenForRun(taskRunId, getDb()),
    ).toEqual([]);
  });

  test("a run in project B can't register project A's connection", async () => {
    await harness.connectToReady("launch-project-a");
    const ownerB = await createProjectSecretsTestUser("launch-project-b");
    const projectB = await createProjectSecretsTestProject(apiClient, ownerB);
    const { taskRunId, claimToken } = await startAndClaim(
      ownerB,
      projectB,
      notionRef,
    );

    const { data, error } = await register(ownerB, taskRunId, claimToken);

    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: {
        state: "disconnected",
        reasonCode: null,
        key: "notion",
        label: null,
      },
      detail:
        'MCP server "notion" uses the "notion" connection, which this project doesn\'t have: a project admin must connect it',
    });
  });

  test("registering again under the same claim rotates the capability", async () => {
    const { owner, projectId } = await harness.connectToReady("launch-rotate");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );

    const first = await unwrapAsync(register(owner, taskRunId, claimToken));
    const second = await unwrapAsync(register(owner, taskRunId, claimToken));

    const before = first.entries["notion"];
    const after = second.entries["notion"];
    expect(after?.capability).not.toBe(before?.capability);
    expect(after?.relayUrl).toBe(before?.relayUrl ?? "");
    expect(await launchByCapability(before?.capability ?? "")).toBeNull();
    expect(await launchByCapability(after?.capability ?? "")).toMatchObject({
      taskRunId,
      state: "open",
    });
  });

  test("completing the run closes its launch connections", async () => {
    const { owner, projectId } = await harness.connectToReady("launch-close");
    const { taskRunId, claimToken } = await startAndClaim(
      owner,
      projectId,
      notionRef,
    );
    const launch = await unwrapAsync(register(owner, taskRunId, claimToken));

    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).completions.post(
        {
          claimToken,
          status: "succeeded",
          resultJson: { ok: true },
          errorJson: null,
        },
        { headers: owner.authHeaders },
      ),
    );

    expect(
      await appContext.managedLaunchRepo.listOpenForRun(taskRunId, getDb()),
    ).toEqual([]);
    expect(
      await launchByCapability(launch.entries["notion"]?.capability ?? ""),
    ).toMatchObject({ state: "closed" });
  }, 30_000);
});
