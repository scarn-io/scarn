import { beforeAll } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskRuns, tasks } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkNotifier } from "@/tasks/task-run/application/work-notifier";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

export type Concurrency = { max: number; waiting: number } | null;
export type Step = { id: UuidV7; version: number; key: string };

/**
 * A project and the calls a concurrency-group test makes through the API:
 * create a step with a limit, start, run, cancel and read its Tasks. Call
 * inside a `describe`.
 */
export const createConcurrencyGroupHarness = (
  name: string,
  { workNotifier }: { workNotifier?: WorkNotifier | undefined } = {},
) => {
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-11-02T12:00:00.000Z")),
    ...(workNotifier ? { workNotifier } : {}),
  });
  const apiClient = createScarnTreaty(createApp(appContext));
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `${name}-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `${name} project`,
          description: `Project for ${name} tests`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  const requireSetup = () => {
    if (!project || !authHeaders) {
      throw new Error("Expected setup to complete");
    }
    return { projectId: parseUuidV7(project.id), headers: { ...authHeaders } };
  };

  /** Creates version `version` of step `key` (a new key by default) with `concurrency`. */
  const createStep = async (
    concurrency: Concurrency,
    { key = `limited_${crypto.randomUUID()}`, version = 1 } = {},
  ): Promise<Step> => {
    const { projectId, headers } = requireSetup();
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key,
          name: "Limited step",
          description: "Step for concurrency group tests",
          prompt: "Do the work.",
          version,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          concurrency,
          grants: [],
          status: "active",
          repo: { mode: "readOnly" },
        },
        { headers },
      ),
    );
    return { id: parseUuidV7(created.id), version: created.version, key };
  };

  const seedItem = async () => await seedWorkItem(requireSetup().projectId);

  /** `POST /tasks`; the raw response, so a 409 can be checked. */
  const postTask = async (workItemId: UuidV7, step: Step) => {
    const { projectId, headers } = requireSetup();
    return await apiClient.api.tasks.post(
      {
        projectId,
        workItemId,
        stepDefinitionId: step.id,
        stepDefinitionVersion: step.version,
        inputJson: null,
      },
      { headers },
    );
  };

  const startTask = async (workItemId: UuidV7, step: Step) =>
    await unwrapAsync(postTask(workItemId, step));

  const cancel = async (taskId: string) =>
    await unwrapAsync(
      apiClient.api.tasks({ taskId }).cancel.post(undefined, {
        headers: requireSetup().headers,
      }),
    );

  /** Claims run `taskRunId` and completes it. */
  const succeedRun = async (workItemId: UuidV7, taskRunId: string) => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `${name}-${crypto.randomUUID()}`,
          batchSize: 10,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimToken = claims.find(
      (claim) => claim.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) {
      throw new Error(`Expected to claim run ${taskRunId}`);
    }
    return await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).completions.post(
        {
          claimToken,
          status: "succeeded",
          resultJson: { done: true },
          errorJson: null,
        },
        { headers },
      ),
    );
  };

  const block = async (blockedWorkItemId: UuidV7, blockingWorkItemId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["work-item-blocks"].post(
        {
          blockedWorkItemId: parseWorkItemId(blockedWorkItemId),
          blockingWorkItemId: parseWorkItemId(blockingWorkItemId),
        },
        { headers: requireSetup().headers },
      ),
    );

  /** A Task's status and its runs' `{ number, reason, status }`. */
  const stateOf = async (taskId: string) => {
    const [task] = await getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const runs = await getDb()
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(asc(taskRuns.number));
    return {
      status: task?.status,
      runs: runs.map(({ number, reason, status }) => ({
        number,
        reason,
        status,
      })),
    };
  };

  const tasksOn = async (workItemId: UuidV7) =>
    await getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.workItemId, workItemId))
      .orderBy(asc(tasks.id));

  return {
    appContext,
    apiClient,
    requireSetup,
    createStep,
    seedItem,
    postTask,
    startTask,
    cancel,
    succeedRun,
    block,
    stateOf,
    tasksOn,
  };
};
