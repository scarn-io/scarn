/**
 * A run may use only the managed connections its own stored config names
 * in `auth` (decision 1), resolved within the run's project.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { loadReferencedManagedConnections } from "@/connections/managed-mcp-connection/application/load-referenced-managed-connections";
import { getDb } from "@/lib/db";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const refWithAuth = { type: "ref", auth: { connection: "notion" } } as const;
const remoteWithAuth = {
  type: "remote",
  url: MANAGED_CONNECTION_PRESETS.notion.resource,
  auth: { connection: "notion" },
} as const;

describe("loadReferencedManagedConnections", () => {
  const harness = createManagedConnectionHarness();
  const { apiClient, fake, appContext } = harness;

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const startRun = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    opencodeMcpJson: Record<string, unknown>,
  ) => {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `referenced_${crypto.randomUUID()}`,
          name: "Referenced connections",
          description: null,
          prompt: "Use Notion.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          opencodeMcpJson: opencodeMcpJson as never,
        },
        { headers: owner.authHeaders },
      ),
    );
    const { run } = await unwrapStartedTaskAsync(
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
    return parseUuidV7(run.id);
  };

  const referencedBy = async (taskRunId: UuidV7) => {
    const db = getDb();
    const run = await appContext.taskRunRepo.load(taskRunId, db);
    if (!run) {
      throw new Error(`expected task run ${taskRunId}`);
    }
    return await loadReferencedManagedConnections(run, appContext, db);
  };

  const newProject = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    return { owner, projectId };
  };

  for (const [type, server] of Object.entries({
    ref: refWithAuth,
    remote: remoteWithAuth,
  })) {
    test(`a ${type} entry with auth resolves to the project's connection`, async () => {
      const { owner, projectId, connectionId } = await harness.connectToReady(
        `referenced-${type}`,
      );
      const taskRunId = await startRun(owner, projectId, { notion: server });

      expect(await referencedBy(taskRunId)).toEqual([
        { key: "notion", name: "notion", connectionId },
      ]);
    });
  }

  test("a run in another project never resolves this project's connection", async () => {
    const a = await harness.connectToReady("referenced-project-a");
    const b = await newProject("referenced-project-b");
    const taskRunId = await startRun(b.owner, b.projectId, {
      notion: refWithAuth,
    });

    const referenced = await referencedBy(taskRunId);

    expect(referenced).toEqual([
      { key: "notion", name: "notion", connectionId: null },
    ]);
    expect(referenced[0]?.connectionId).not.toBe(a.connectionId);
  });

  test("a project with no connection resolves to null", async () => {
    const { owner, projectId } = await newProject("referenced-none");
    const taskRunId = await startRun(owner, projectId, {
      notion: remoteWithAuth,
    });

    expect(await referencedBy(taskRunId)).toEqual([
      { key: "notion", name: "notion", connectionId: null },
    ]);
  });

  test("disabled entries and entries without auth are not referenced", async () => {
    const { owner, projectId } = await harness.connectToReady(
      "referenced-filtered",
    );
    const taskRunId = await startRun(owner, projectId, {
      notion: { ...refWithAuth, disabled: true },
      plain: {
        type: "remote",
        url: "https://example.test/mcp",
      },
    });

    expect(await referencedBy(taskRunId)).toEqual([]);
  });

  test("disconnecting and connecting again keeps the same connection id", async () => {
    const { owner, projectId, connectionId } = await harness.connectToReady(
      "referenced-reconnect",
    );
    const taskRunId = await startRun(owner, projectId, {
      notion: refWithAuth,
    });
    const expected = [{ key: "notion", name: "notion", connectionId }];

    await harness.disconnect(owner, projectId, connectionId);
    expect(await referencedBy(taskRunId)).toEqual(expected);

    const started = await harness.startConnect(owner, projectId);
    await harness.callback(
      await harness.authorize(started.authorizationUrl),
      owner.authHeaders,
    );
    const pending = await harness.getConnection(owner, projectId, connectionId);
    const ready = await unwrapAsync(
      harness
        .connections(projectId)({ connectionId })
        .candidate.confirm.post(
          {
            candidateId: pending.candidate?.id ?? "",
            fingerprint: pending.candidate?.fingerprint ?? "",
            expectedVersion: pending.version,
          },
          { headers: { ...owner.authHeaders, origin: harness.origin } },
        ),
    );
    expect(ready.state).toBe("ready");
    expect(await referencedBy(taskRunId)).toEqual(expected);
  });
});
