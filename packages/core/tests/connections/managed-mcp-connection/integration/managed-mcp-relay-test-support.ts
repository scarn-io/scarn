import { expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import type { ProjectSecretsTestUser } from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import type { createManagedConnectionHarness } from "./managed-connection-test-support";

export const RELAY_PROTOCOL_VERSION = "2025-06-18";

export type RelayLaunch = {
  owner: ProjectSecretsTestUser;
  taskRunId: UuidV7;
  claimToken: string;
  relayUrl: string;
  capability: string;
};

export const rpc = (id: number, method: string, params: object = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

/**
 * Launches runs against `harness` and calls their relay the way an agent's
 * MCP client would, with after-response work kept for
 * `harness.settleBackgroundTasks`.
 */
export const createRelayTestClient = (
  harness: ReturnType<typeof createManagedConnectionHarness>,
) => {
  const { apiClient, fake } = harness;

  const register = async (
    owner: ProjectSecretsTestUser,
    taskRunId: UuidV7,
    claimToken: string,
    key = "notion",
  ) => {
    const launch = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId })["managed-launch"].post(
        {
          claimToken,
          entries: { [key]: { url: fake.resource } },
          remotesWithoutAuth: {},
        },
        { headers: owner.authHeaders },
      ),
    );
    const entry = launch.entries[key];
    if (!entry) {
      throw new Error(`expected a ${key} entry`);
    }
    return entry;
  };

  /**
   * A claimed run in `projectId` whose step references each of
   * `connections` by an MCP server key of the same name, launched with each
   * entry's URL from `urls` (the fake's resource by default); returns every
   * entry.
   */
  const launchIn = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    connections: readonly string[] = ["notion"],
    urls: Readonly<Record<string, string>> = {},
  ) => {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `relay_${crypto.randomUUID()}`,
          name: "Managed relay",
          description: null,
          prompt: "Use the connections.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          opencodeMcpJson: Object.fromEntries(
            connections.map((connection) => [
              connection,
              { type: "ref", auth: { connection } },
            ]),
          ) as never,
        },
        { headers: owner.authHeaders },
      ),
    );
    await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 600,
        },
        { headers: owner.authHeaders },
      ),
    );
    const [claim] = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: "relay-worker",
          batchSize: 1,
          leaseDurationSeconds: 60,
        },
        { headers: owner.authHeaders },
      ),
    );
    if (!claim) {
      throw new Error("expected a claim");
    }
    const taskRunId = parseUuidV7(claim.task.id);
    const launched = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId })["managed-launch"].post(
        {
          claimToken: claim.claimToken,
          entries: Object.fromEntries(
            connections.map((connection) => [
              connection,
              { url: urls[connection] ?? fake.resource },
            ]),
          ),
          remotesWithoutAuth: {},
        },
        { headers: owner.authHeaders },
      ),
    );
    return {
      owner,
      taskRunId,
      claimToken: claim.claimToken,
      entries: launched.entries,
    };
  };

  /** A ready connection and a claimed run whose step references it, launched. */
  const launch = async (label: string): Promise<RelayLaunch> => {
    const { owner, projectId } = await harness.connectToReady(label);
    const launched = await launchIn(owner, projectId);
    const entry = launched.entries["notion"];
    if (!entry) {
      throw new Error("expected a notion entry");
    }
    fake.mcp.calls.length = 0;
    return {
      owner,
      taskRunId: launched.taskRunId,
      claimToken: launched.claimToken,
      ...entry,
    };
  };

  const relay = (
    target: Pick<RelayLaunch, "relayUrl" | "capability">,
    init: {
      method?: string;
      body?: object | string;
      headers?: Record<string, string>;
      url?: string;
      signal?: AbortSignal;
    } = {},
  ) =>
    harness.handleWithBackgroundTasks(
      new Request(init.url ?? target.relayUrl, {
        method: init.method ?? "POST",
        ...(init.signal ? { signal: init.signal } : {}),
        headers: {
          authorization: `Bearer ${target.capability}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": RELAY_PROTOCOL_VERSION,
          ...init.headers,
        },
        ...(init.body === undefined
          ? {}
          : {
              body:
                typeof init.body === "string"
                  ? init.body
                  : JSON.stringify(init.body),
            }),
      }),
    );

  const initialize = async (target: RelayLaunch) => {
    const response = await relay(target, {
      body: rpc(1, "initialize", {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "relay-test", version: "0" },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("expected a session id");
    }
    return sessionId;
  };

  return { register, launch, launchIn, relay, initialize };
};
