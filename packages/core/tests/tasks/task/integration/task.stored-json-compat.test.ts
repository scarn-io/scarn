/**
 * Stored `tasks` and `task_runs` rows stay readable as the Task write rules
 * evolve. Rows are written directly, bypassing the entities, to stand in for
 * Tasks and runs created by older code. See
 * `docs/persistence/json-columns.md`.
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { Logger } from "@scarn/observability/logging";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects, taskRuns } from "@/lib/db/schema";
import { DrizzleTaskRepo } from "@/tasks/task/infra/drizzle-task-repo";
import { DrizzleTaskSummaryReader } from "@/tasks/task/infra/drizzle-task-summary-reader";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import v1FailedRun from "../../task-run/fixtures/v1-failed-run.json";
import v1SucceededRun from "../../task-run/fixtures/v1-succeeded-run.json";
import v1TimeoutRun from "../../task-run/fixtures/v1-timeout-run.json";
import {
  insertStoredTask,
  seedStoredTaskOwners,
  storedTaskFixtures,
  type StoredTaskFixture,
  type StoredTaskOwners,
} from "./stored-task-fixtures";

const NOW = new Date("2026-11-24T12:00:00.000Z");

const recordingLogger = () => {
  const errors: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger;
  return { logger, errors };
};

const rejectionOf = async <T>(promise: Promise<T>) => {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
};

const withOwners = async (run: (owners: StoredTaskOwners) => Promise<void>) => {
  const owners = await seedStoredTaskOwners();
  try {
    await run(owners);
  } finally {
    await getDb().delete(projects).where(eq(projects.id, owners.projectId));
  }
};

const insertStoredRun = async (
  owners: StoredTaskOwners,
  taskId: UuidV7,
  fixture: { status: string; resultJson: unknown; errorJson: unknown },
  workItemId: UuidV7 | null = owners.workItemId,
): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(taskRuns)
    .values({
      id,
      taskId,
      number: 1,
      reason: "initial",
      projectId: owners.projectId,
      workItemId,
      status: fixture.status as "succeeded",
      resultJson: fixture.resultJson,
      errorJson: fixture.errorJson,
      completedAt: NOW,
    });
  return id;
};

describe("task stored json compatibility", () => {
  for (const [name, fixture] of Object.entries(storedTaskFixtures)) {
    concurrentTest(`reads the v1 ${name} fixture through the repos`, () =>
      withOwners(async (owners) => {
        const taskId = await insertStoredTask(owners, fixture);
        const task = await new DrizzleTaskRepo().load(taskId);

        expect<string | undefined>(task?.kind).toBe(fixture.kind);
        expect(task?.entrypointJson).toEqual(fixture.entrypointJson as never);
        expect(task?.toolCallJson).toEqual(fixture.toolCallJson as never);
        expect(task?.resultSchemaJson).toEqual(
          fixture.resultSchemaJson as never,
        );
        expect(task?.inputJson).toEqual(fixture.inputJson);
        expect(task?.retryJson).toEqual(fixture.retryJson as never);
        expect(task?.grants as unknown).toEqual(fixture.grantsJson);
        expect(task?.resultJson).toEqual(fixture.resultJson);
        expect(task?.errorJson).toEqual(fixture.errorJson as never);
        expect(task?.startedByScheduleId).toBe(
          fixture.owner === "schedule" ? owners.scheduleId : null,
        );
        expect(task?.environmentSelection?.extraConnectors).toEqual(
          (
            fixture.environmentSelectionJson as {
              extraConnectors?: unknown;
            } | null
          )?.extraConnectors as never,
        );

        const runId = await insertStoredRun(
          owners,
          taskId,
          v1SucceededRun,
          task?.workItemId ?? null,
        );
        const run = await new DrizzleTaskRunRepo(fixedTimeProvider(NOW)).load(
          runId,
        );
        expect<string | undefined>(run?.kind).toBe(fixture.kind);
        expect(run?.inputJson).toEqual(fixture.inputJson);
        expect(run?.resultSchemaJson).toEqual(
          fixture.resultSchemaJson as never,
        );
        expect(run?.resultJson).toEqual(v1SucceededRun.resultJson);
      }),
    );
  }

  for (const [name, fixture] of [
    ["failed", v1FailedRun],
    ["timeout", v1TimeoutRun],
  ] as const) {
    concurrentTest(`reads the ${name} run fixture through the repo`, () =>
      withOwners(async (owners) => {
        const taskId = await insertStoredTask(
          owners,
          storedTaskFixtures.failed,
        );
        const runId = await insertStoredRun(owners, taskId, fixture);
        const [run] = await new DrizzleTaskRunRepo(
          fixedTimeProvider(NOW),
        ).listByTaskId(taskId);
        expect(run?.id).toBe(runId);
        expect(run?.errorJson).toEqual(fixture.errorJson);
      }),
    );
  }

  concurrentTest(
    "an unreadable Task is logged and skipped by list reads, and throws on single reads",
    () =>
      withOwners(async (owners) => {
        const { logger, errors } = recordingLogger();
        const repo = new DrizzleTaskRepo(logger);
        const scheduled = {
          ...(storedTaskFixtures.scheduled as StoredTaskFixture),
          status: "queued",
        };
        const readableId = await insertStoredTask(owners, scheduled);
        const badGrantsId = await insertStoredTask(owners, scheduled, {
          grantsJson: { resource: "workItem" },
        });
        const futureVersionId = await insertStoredTask(owners, scheduled, {
          schemaVersion: 99,
        });

        const listed = await getDb().transaction((tx) =>
          repo.listLiveInConcurrencyGroup(
            { projectId: owners.projectId, scheduleId: owners.scheduleId },
            tx,
          ),
        );
        expect(listed.map((task) => task.id)).toEqual([readableId]);

        const loggedIds = errors.map(
          ([fields]) => (fields as { taskId?: string }).taskId,
        );
        expect(loggedIds).toContain(badGrantsId);
        expect(loggedIds).toContain(futureVersionId);

        for (const id of [badGrantsId, futureVersionId]) {
          expect(await rejectionOf(repo.load(id))).toMatchObject({
            code: "TASK_ROW_UNREADABLE",
          });
        }
      }),
  );

  concurrentTest(
    "an unreadable run or Task is logged and skipped by run list reads, and throws on single reads",
    () =>
      withOwners(async (owners) => {
        const { logger, errors } = recordingLogger();
        const repo = new DrizzleTaskRunRepo(fixedTimeProvider(NOW), logger);
        const readableTaskId = await insertStoredTask(
          owners,
          storedTaskFixtures.code,
        );
        const readableRunId = await insertStoredRun(
          owners,
          readableTaskId,
          v1SucceededRun,
        );
        const futureTaskId = await insertStoredTask(
          owners,
          storedTaskFixtures.code,
          { schemaVersion: 99 },
        );
        const futureTaskRunId = await insertStoredRun(
          owners,
          futureTaskId,
          v1SucceededRun,
        );

        const listed = await repo.listByProjectId(owners.projectId);
        expect(listed.map((run) => run.id)).toEqual([readableRunId]);
        expect(
          errors.map(
            ([fields]) => (fields as { taskRunId?: string }).taskRunId,
          ),
        ).toContain(futureTaskRunId);

        expect(await rejectionOf(repo.load(futureTaskRunId))).toMatchObject({
          code: "TASK_RUN_ROW_UNREADABLE",
        });
      }),
  );

  concurrentTest(
    "a failed Task's error message is read from its stored error_json in SQL",
    () =>
      withOwners(async (owners) => {
        const failed = storedTaskFixtures.failed;
        const taskId = await insertStoredTask(owners, failed);
        const summary = await new DrizzleTaskSummaryReader().loadByTaskId(
          taskId,
        );
        expect(summary?.errorMessage).toBe(failed.errorJson.message);
      }),
  );
});
