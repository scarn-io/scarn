import { beforeAll, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { EnvironmentContentInput } from "@/common/contracts/environment";
import { getDb } from "@/lib/db";
import { taskExecutionConfigs } from "@/lib/db/schema";
import { unwrapAsync } from "tests/utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import {
  createEnvironmentsTestClient,
  createEnvironmentsTestProject,
  createEnvironmentsTestUser,
  environmentContent,
  uniqueEnvironmentName,
  type EnvironmentsTestUser,
} from "tests/pipeline-definitions/environment/integration/environment-test-support";

type TaskEnvironmentBody = {
  name?: string;
  extraConnectors?: {
    connectorId: string;
    vars: Record<string, { secret: string }>;
  }[];
};

export const expect422 = (
  result: { error: { status: number; value: unknown } | null },
  code: string,
) => {
  expect(result.error?.status).toBe(422);
  expect(result.error?.value).toMatchObject({ code });
};

export const fromStep = (step: { id: string; version: number }) => ({
  stepDefinitionId: parseUuidV7(step.id),
  stepDefinitionVersion: step.version,
});

/**
 * A project and owner (set up in `beforeAll`) with helpers that publish
 * environments, put step definitions and start Tasks with an `environment`.
 */
export const useEnvironmentSelectionProject = (label: string) => {
  const apiClient = createEnvironmentsTestClient();
  let owner: EnvironmentsTestUser;
  let projectId: UuidV7;

  beforeAll(async () => {
    owner = await createEnvironmentsTestUser(label);
    projectId = await createEnvironmentsTestProject(apiClient, owner);
  });

  const publish = async (
    content: EnvironmentContentInput = environmentContent(),
    name: string = uniqueEnvironmentName(),
  ) => {
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .environments({ name })
        .put({ content }, { headers: owner.authHeaders }),
    );
    return name;
  };

  const deleteEnvironment = async (name: string) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .environments({ name })
        .delete(undefined, { headers: owner.authHeaders }),
    );

  const putStep = async (fields: Record<string, unknown> = {}) =>
    await unwrapAsync(
      apiClient.api["step-definitions"].put(
        {
          projectId,
          key: `selection-${crypto.randomUUID().slice(0, 8)}`,
          name: "Selection step",
          kind: "user_defined",
          version: 1,
          description: null,
          prompt: "Do the thing",
          inputSchemaJson: { type: "object", properties: {} },
          resultSchemaJson: null,
          status: "active",
          ...fields,
        } as never,
        { headers: owner.authHeaders },
      ),
    );

  const postTask = async (
    source:
      | { prompt: string; repoWrite?: boolean }
      | { stepDefinitionId: UuidV7; stepDefinitionVersion: number },
    environment?: TaskEnvironmentBody,
  ) =>
    await apiClient.api.tasks.post(
      {
        projectId,
        workItemId: await seedWorkItem(projectId),
        ...source,
        ...(environment === undefined ? {} : { environment }),
      },
      { headers: owner.authHeaders },
    );

  const getTask = async (taskId: string) =>
    await unwrapAsync(
      apiClient.api.tasks({ taskId }).get({ headers: owner.authHeaders }),
    );

  const configOf = async (id: string | null) => {
    if (id === null) return null;
    const [row] = await getDb()
      .select({
        environment: taskExecutionConfigs.environmentJson,
        git: taskExecutionConfigs.gitJson,
        mcp: taskExecutionConfigs.mcpJson,
      })
      .from(taskExecutionConfigs)
      .where(eq(taskExecutionConfigs.id, id));
    return row ?? null;
  };

  const claim = async (workItemId: string, taskRunId: string) => {
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId: parseUuidV7(workItemId),
          workerId: `selection-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers: owner.authHeaders },
      ),
    );
    const claimToken = claims.find(
      (each) => each.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) throw new Error(`Expected to claim run ${taskRunId}`);
    return claimToken;
  };

  const workerContext = async (taskRunId: string, claimToken: string) =>
    await apiClient.api["task-runs"]({ taskRunId })["worker-context"].post(
      { claimToken },
      { headers: owner.authHeaders },
    );

  const requestSecrets = async (
    taskRunId: string,
    claimToken: string,
    secretNames: string[],
  ) =>
    await apiClient.api["task-runs"]({ taskRunId }).environment.post(
      { claimToken, secretNames },
      { headers: owner.authHeaders },
    );

  const runsOf = async (taskId: string) =>
    await unwrapAsync(
      apiClient.api.tasks({ taskId }).runs.get({ headers: owner.authHeaders }),
    );

  return {
    publish,
    deleteEnvironment,
    putStep,
    postTask,
    getTask,
    configOf,
    claim,
    workerContext,
    requestSecrets,
    runsOf,
    context: () => ({ apiClient, owner, projectId }),
  };
};
