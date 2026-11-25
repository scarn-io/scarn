import { afterAll, describe, expect, test } from "bun:test";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  managedMcpLaunchConnections,
  pipelineGraphs,
  pipelineGraphVersions,
  pipelineGraphVersionSteps,
  stepDefinitions,
  taskExecutionConfigs,
  taskRuns,
  tasks,
  workItems,
} from "@/lib/db/schema";
import {
  addWriteMember,
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const remote = {
  type: "remote",
  url: "https://mcp.notion.com/mcp",
  auth: { connection: "notion" },
};

const createConfig = async (
  projectId: UuidV7,
  mcpJson: Record<string, object>,
) => {
  const id = createUuidV7();
  await getDb().insert(taskExecutionConfigs).values({
    id,
    projectId,
    schemaVersion: 1,
    contentHash: id,
    mcpJson,
  });
  return id;
};

const createStep = async (
  projectId: UuidV7,
  key: string,
  taskExecutionConfigId: UuidV7 | null,
  version = 1,
  status: "active" | "draft" | "archived" = "active",
) => {
  const id = createUuidV7();
  const step = { id, key, name: `Step ${key} v${String(version)}` };
  await getDb()
    .insert(stepDefinitions)
    .values({
      ...step,
      projectId,
      version,
      status,
      taskExecutionConfigId,
      kind: "user_defined",
      schemaVersion: 1,
      prompt: "Use MCP",
      inputSchemaJson: { type: "object" },
      resultSchemaJson: { type: "object" },
    });
  return step;
};

const createPipeline = async (
  projectId: UuidV7,
  key: string,
  stepDefinitionId: UuidV7,
  archived = false,
) => {
  const pipeline = { id: createUuidV7(), key, name: `Pipeline ${key}` };
  const versionId = createUuidV7();
  await getDb()
    .insert(pipelineGraphs)
    .values({
      ...pipeline,
      projectId,
      currentVersionId: versionId,
      archivedAt: archived ? new Date() : null,
    });
  await getDb().insert(pipelineGraphVersions).values({
    id: versionId,
    pipelineGraphId: pipeline.id,
    version: 1,
    definitionJson: {},
    schemaVersion: 1,
    contentHash: versionId,
  });
  await getDb().insert(pipelineGraphVersionSteps).values({
    pipelineGraphVersionId: versionId,
    stepKey: "step",
    stepDefinitionId,
  });
  return pipeline;
};

const createRun = async (projectId: UuidV7) => {
  const taskId = createUuidV7();
  const id = createUuidV7();
  const workItemId = createUuidV7();
  await getDb()
    .insert(workItems)
    .values({
      id: workItemId,
      projectId,
      platform: "github",
      platformKey: `usage-${workItemId}`,
      title: "Managed connection usage",
    });
  await getDb().insert(tasks).values({
    id: taskId,
    projectId,
    workItemId,
    kind: "agent",
    prompt: "Use MCP",
    status: "queued",
    schemaVersion: 1,
  });
  await getDb().insert(taskRuns).values({
    id,
    projectId,
    taskId,
    workItemId,
    number: 1,
    reason: "initial",
    status: "pending",
  });
  return id;
};

describe("managed connection usage API", () => {
  const harness = createManagedConnectionHarness();
  const { apiClient, connections } = harness;

  afterAll(async () => {
    await harness.fake.stop();
  });

  test("returns latest active step identities, current pipeline uses and distinct open runs", async () => {
    const { owner, projectId, connectionId, ready, candidate } =
      await harness.connectToReady("usage");
    const configId = await createConfig(projectId, { notion: remote });
    const old = await createStep(projectId, "used", configId);
    const latest = await createStep(projectId, "used", configId, 2);
    await createStep(projectId, "used", configId, 3, "draft");
    await createStep(projectId, "used", configId, 4, "archived");
    const standalone = await createStep(projectId, "standalone", configId);
    await createStep(projectId, "draft", configId, 1, "draft");
    await createStep(projectId, "archived", configId, 1, "archived");
    await createStep(projectId, "default", null);
    await createStep(
      projectId,
      "disabled",
      await createConfig(projectId, {
        notion: { ...remote, disabled: true },
      }),
    );
    await createStep(projectId, "removed", configId);
    await createStep(projectId, "removed", null, 2);
    const otherProjectId = await createProjectSecretsTestProject(
      apiClient,
      owner,
    );
    await createStep(
      otherProjectId,
      "other-project",
      await createConfig(otherProjectId, { notion: remote }),
    );
    const pipeline = await createPipeline(projectId, "current", latest.id);
    await createPipeline(projectId, "old-pin", old.id);
    await createPipeline(projectId, "archived", latest.id, true);

    const runId = await createRun(projectId);
    const closedRunId = await createRun(projectId);
    await getDb()
      .insert(managedMcpLaunchConnections)
      .values(
        ["notion", "notion-duplicate", "closed"].map((entryKey) => ({
          id: createUuidV7(),
          projectId,
          taskRunId: entryKey === "closed" ? closedRunId : runId,
          claimTokenDigest: Buffer.from("claim"),
          entryKey,
          connectionId,
          generation: ready.generation,
          grantId: candidate.id,
          capabilityDigest: Buffer.from(createUuidV7()),
          state:
            entryKey === "closed" ? ("closed" as const) : ("open" as const),
          closedAt: entryKey === "closed" ? new Date() : null,
        })),
      );

    const usage = await unwrapAsync(
      connections(projectId)({ connectionId }).usage.get({
        headers: owner.authHeaders,
      }),
    );

    expect(usage).toEqual({
      steps: [
        { ...standalone, pipelines: [] },
        { ...latest, pipelines: [pipeline] },
      ],
      liveRuns: 1,
    });
  });

  test("allows a member without secrets:write and hides usage from non-members and other projects", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("usage-auth");
    const member = await createProjectSecretsTestUser("usage-member");
    await addWriteMember(apiClient, projectId, owner, member);
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .members({ userId: parseUuidV7(member.userId) })
        .role.put({ role: "read" }, { headers: owner.authHeaders }),
    );
    expect(
      await unwrapAsync(
        connections(projectId)({ connectionId }).usage.get({
          headers: member.authHeaders,
        }),
      ),
    ).toEqual({ steps: [], liveRuns: 0 });

    const stranger = await createProjectSecretsTestUser("usage-stranger");
    for (const headers of [stranger.authHeaders, {}]) {
      const response = await connections(projectId)({ connectionId }).usage.get(
        {
          headers,
        },
      );
      expect(response.status).toBe(404);
      expect(response.data).toBeNull();
    }
    const otherProjectId = await createProjectSecretsTestProject(
      apiClient,
      owner,
    );
    for (const id of [connectionId, createUuidV7()]) {
      const response = await connections(otherProjectId)({
        connectionId: id,
      }).usage.get({ headers: owner.authHeaders });
      expect(response.status).toBe(404);
      expect(response.data).toBeNull();
    }
  });
});
