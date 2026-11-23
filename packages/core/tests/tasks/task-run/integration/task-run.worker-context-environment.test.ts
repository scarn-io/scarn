import { beforeAll, describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { EnvironmentContentInput } from "@/common/contracts/environment";
import { getDb } from "@/lib/db";
import {
  environments,
  environmentVersions,
  taskRuns,
  tasks,
} from "@/lib/db/schema";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import {
  createEnvironmentsTestClient,
  createEnvironmentsTestProject,
  createEnvironmentsTestUser,
  environmentContent,
  putStepUsingEnvironment,
  uniqueEnvironmentName,
  type EnvironmentsTestUser,
} from "tests/pipeline-definitions/environment/integration/environment-test-support";

const V1 = environmentContent({ description: "v1" });
const V2 = environmentContent({ description: "v2" });

describe("task worker context: named environment version", () => {
  const apiClient = createEnvironmentsTestClient();
  let owner: EnvironmentsTestUser;
  let projectId: UuidV7;

  beforeAll(async () => {
    owner = await createEnvironmentsTestUser("worker-context");
    projectId = await createEnvironmentsTestProject(apiClient, owner);
  });

  const publish = async (name: string, content: EnvironmentContentInput) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .environments({ name })
        .put({ content }, { headers: owner.authHeaders }),
    );

  const stepUsing = async (name: string) =>
    await putStepUsingEnvironment(
      apiClient,
      owner.authHeaders,
      projectId,
      `uses-${name}-${crypto.randomUUID().slice(0, 8)}`,
      name,
    );

  const startTask = async (step: { id: string; version: number }) => {
    const workItemId = await seedWorkItem(projectId);
    const started = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: parseUuidV7(step.id),
          stepDefinitionVersion: step.version,
          inputJson: null,
        },
        { headers: owner.authHeaders },
      ),
    );
    const taskRunId = started.run?.id;
    if (!taskRunId) {
      throw new Error("Expected the Task to start with a run");
    }
    return { workItemId, taskId: parseUuidV7(started.task.id), taskRunId };
  };

  const claim = async (workItemId: UuidV7, taskRunId: string) => {
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `environment-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers: owner.authHeaders },
      ),
    );
    const claimToken = claims.find(
      (each) => each.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) {
      throw new Error("Expected to claim the run");
    }
    return claimToken;
  };

  const environmentOf = async (taskRunId: string, claimToken: string) =>
    (
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId })["worker-context"].post(
          { claimToken },
          { headers: owner.authHeaders },
        ),
      )
    ).runtime.environment;

  const pinnedVersionOf = async (taskRunId: string) =>
    (
      await getDb()
        .select({ id: taskRuns.environmentVersionId })
        .from(taskRuns)
        .where(eq(taskRuns.id, taskRunId))
    )[0]?.id ?? null;

  const versionIdOf = async (name: string, version: number) => {
    const [row] = await getDb()
      .select({ id: environmentVersions.id })
      .from(environmentVersions)
      .innerJoin(
        environments,
        eq(environments.id, environmentVersions.environmentId),
      )
      .where(
        and(
          eq(environments.projectId, projectId),
          eq(environments.name, name),
          eq(environmentVersions.version, version),
        ),
      );
    if (!row) {
      throw new Error(`Expected ${name} v${String(version)}`);
    }
    return row.id;
  };

  concurrentTest(
    "a run pins the latest version and keeps it after a newer one is published; a new Task gets the newer one",
    async () => {
      const name = uniqueEnvironmentName();
      await publish(name, V1);
      const step = await stepUsing(name);
      const first = await startTask(step);
      const claimToken = await claim(first.workItemId, first.taskRunId);

      expect(await environmentOf(first.taskRunId, claimToken)).toMatchObject({
        kind: "named",
        name,
        version: 1,
        content: V1,
      });
      expect(await pinnedVersionOf(first.taskRunId)).toBe(
        await versionIdOf(name, 1),
      );

      await publish(name, V2);
      expect(await environmentOf(first.taskRunId, claimToken)).toMatchObject({
        version: 1,
        content: V1,
      });

      const second = await startTask(step);
      expect(
        await environmentOf(
          second.taskRunId,
          await claim(second.workItemId, second.taskRunId),
        ),
      ).toMatchObject({ kind: "named", name, version: 2, content: V2 });
    },
  );

  concurrentTest(
    "a continuation keeps the version its Task's earlier run used",
    async () => {
      const name = uniqueEnvironmentName();
      await publish(name, V1);
      const { workItemId, taskId, taskRunId } = await startTask(
        await stepUsing(name),
      );
      const claimToken = await claim(workItemId, taskRunId);
      await environmentOf(taskRunId, claimToken);
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId }).yields.post(
          { claimToken, message: "Which one?" },
          { headers: owner.authHeaders },
        ),
      );
      await publish(name, V2);
      const conversationId = (
        await getDb()
          .select({ id: tasks.conversationId })
          .from(tasks)
          .where(eq(tasks.id, taskId))
      )[0]?.id;
      if (!conversationId) {
        throw new Error("Expected the Task's conversation");
      }

      await unwrapAsync(
        apiClient.api
          .conversations({ conversationId: parseUuidV7(conversationId) })
          .messages.post({ body: "v1." }, { headers: owner.authHeaders }),
      );
      const continuationId = (
        await getDb()
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.number, 2)))
      )[0]?.id;
      if (!continuationId) {
        throw new Error("Expected the continuation run");
      }

      expect(await pinnedVersionOf(continuationId)).toBe(
        await versionIdOf(name, 1),
      );
      expect(
        await environmentOf(
          continuationId,
          await claim(workItemId, continuationId),
        ),
      ).toMatchObject({ kind: "named", name, version: 1, content: V1 });
    },
  );

  concurrentTest(
    "a deleted environment is not found when the run is claimed",
    async () => {
      const name = uniqueEnvironmentName();
      await publish(name, V1);
      const step = await stepUsing(name);
      const { workItemId, taskRunId } = await startTask(step);
      await unwrapAsync(
        apiClient.api["step-definitions"]({
          stepDefinitionId: parseUuidV7(step.id),
        }).archive.put(undefined, { headers: owner.authHeaders }),
      );
      await unwrapAsync(
        apiClient.api
          .projects({ projectId })
          .environments({ name })
          .delete(undefined, { headers: owner.authHeaders }),
      );

      expect(
        await environmentOf(taskRunId, await claim(workItemId, taskRunId)),
      ).toEqual({ kind: "named", name, notFound: true });
      expect(await pinnedVersionOf(taskRunId)).toBeNull();
    },
  );

  concurrentTest(
    "a version inherited from a different environment is replaced by the step's own",
    async () => {
      const name = uniqueEnvironmentName();
      const other = uniqueEnvironmentName();
      await publish(name, V1);
      await publish(other, V2);
      const { workItemId, taskRunId } = await startTask(await stepUsing(name));
      await getDb()
        .update(taskRuns)
        .set({ environmentVersionId: await versionIdOf(other, 1) })
        .where(eq(taskRuns.id, taskRunId));

      expect(
        await environmentOf(taskRunId, await claim(workItemId, taskRunId)),
      ).toMatchObject({ kind: "named", name, version: 1, content: V1 });
      expect(await pinnedVersionOf(taskRunId)).toBe(await versionIdOf(name, 1));
    },
  );

  concurrentTest(
    "the worker context carries the step's declared errors",
    async () => {
      const name = uniqueEnvironmentName();
      await publish(name, V1);
      const key = `declares-${crypto.randomUUID().slice(0, 8)}`;
      const step = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          {
            projectId,
            key,
            name: `Step ${key}`,
            kind: "user_defined",
            version: 1,
            description: null,
            prompt: "Do the thing",
            inputSchemaJson: { type: "object", properties: {} },
            resultSchemaJson: null,
            status: "active",
            environment: { kind: "named", name },
            errors: ["Billing.Declined", "Billing.Expired"],
          },
          { headers: owner.authHeaders },
        ),
      );
      const { workItemId, taskRunId } = await startTask(step);
      const claimToken = await claim(workItemId, taskRunId);

      const context = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId })["worker-context"].post(
          { claimToken },
          { headers: owner.authHeaders },
        ),
      );
      expect(context.task.declaredErrors).toEqual([
        "Billing.Declined",
        "Billing.Expired",
      ]);
    },
  );
});
