/**
 * DB-backed coverage for `resetLocalDevProject`. Each project gets a run whose
 * step visit's Task (`node_visits.task_id`) has a first run that handed over a
 * conversation, a reply, and a completed continuation run
 * (`previous_task_run_id`) with a buffered log line. Reset empties the target
 * project's work, keeps its project, step definitions and pipeline
 * definitions, and leaves the other project untouched.
 *
 * Placement: same reasoning as `tests/demo-project/seed-demo-needs-input.test.ts`.
 * It hits Postgres via testcontainers and calls application code, so neither
 * `unit/` nor `integration/` fits.
 */
import { beforeAll, describe, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  conversationMessages,
  conversations,
  nodeVisits,
  pipelineGraphVersions,
  pipelineGraphs,
  pipelineRuns,
  projects,
  stepDefinitions,
  taskLogLines,
  taskRuns,
  tasks,
  userNotifications,
  workItems,
} from "@/lib/db/schema";
import { ResourceNotFoundError } from "@/lib/errors";
import { resetLocalDevProject } from "@/local-dev/application/reset-local-dev-project";
import { serialTest, unwrapAsync } from "tests/utils";
import { createConversationHarness } from "tests/pipeline-executions/pipeline-run/integration/conversation-test-support";

type ConversationHarness = ReturnType<typeof createConversationHarness>;

const seedWork = async (subject: ConversationHarness) => {
  const { harness, reply, startHandedOverRun } = subject;
  const { workItemId, conversationId } = await startHandedOverRun();
  await unwrapAsync(reply(conversationId, "Target v2; v1 is deprecated."));
  const continuation = await harness.claimOne(workItemId);
  await harness.complete(continuation, "succeeded");
  await harness.appContext.logFeedStore.append(
    parseUuidV7(continuation.taskId),
    [
      {
        seq: 1,
        stream: "worker",
        ts: "2026-06-01T09:00:00.000Z",
        content: "working",
        level: "info",
      },
    ],
  );
};

const countWork = async (projectId: UuidV7) => {
  const db = getDb();
  const runRows = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.projectId, projectId));
  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  const runRowsOfTasks = await db
    .select({ id: taskRuns.id, number: taskRuns.number })
    .from(taskRuns)
    .where(eq(taskRuns.projectId, projectId));
  const conversationRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.projectId, projectId));
  const runIds = runRows.map((row) => row.id);
  const taskIds = taskRows.map((row) => row.id);
  const taskRunIds = runRowsOfTasks.map((row) => row.id);
  const conversationIds = conversationRows.map((row) => row.id);
  const countIn = async <T>(query: () => Promise<T[]>, ids: string[]) =>
    ids.length === 0 ? 0 : (await query()).length;

  return {
    runs: runRows.length,
    tasks: taskRows.length,
    taskRuns: runRowsOfTasks.length,
    chainedRuns: runRowsOfTasks.filter((row) => row.number > 1).length,
    conversations: conversationRows.length,
    workItems: (
      await db
        .select({ id: workItems.id })
        .from(workItems)
        .where(eq(workItems.projectId, projectId))
    ).length,
    notifications: (
      await db
        .select({ id: userNotifications.id })
        .from(userNotifications)
        .where(eq(userNotifications.projectId, projectId))
    ).length,
    visits: await countIn(
      () =>
        db
          .select({ id: nodeVisits.id })
          .from(nodeVisits)
          .where(inArray(nodeVisits.pipelineRunId, runIds)),
      runIds,
    ),
    taskLinkedVisits: await countIn(
      () =>
        db
          .select({ id: nodeVisits.id })
          .from(nodeVisits)
          .where(inArray(nodeVisits.taskId, taskIds)),
      taskIds,
    ),
    logLines: await countIn(
      () =>
        db
          .select({ id: taskLogLines.id })
          .from(taskLogLines)
          .where(inArray(taskLogLines.taskRunId, taskRunIds)),
      taskRunIds,
    ),
    messages: await countIn(
      () =>
        db
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(inArray(conversationMessages.conversationId, conversationIds)),
      conversationIds,
    ),
  };
};

const countDefinitions = async (projectId: UuidV7) => {
  const db = getDb();
  const graphRows = await db
    .select({ id: pipelineGraphs.id })
    .from(pipelineGraphs)
    .where(eq(pipelineGraphs.projectId, projectId));
  const graphIds = graphRows.map((row) => row.id);
  return {
    projects: (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
    ).length,
    stepDefinitions: (
      await db
        .select({ id: stepDefinitions.id })
        .from(stepDefinitions)
        .where(eq(stepDefinitions.projectId, projectId))
    ).length,
    pipelineGraphs: graphRows.length,
    pipelineGraphVersions:
      graphIds.length === 0
        ? 0
        : (
            await db
              .select({ id: pipelineGraphVersions.id })
              .from(pipelineGraphVersions)
              .where(inArray(pipelineGraphVersions.pipelineGraphId, graphIds))
          ).length,
  };
};

describe("resetLocalDevProject", () => {
  const target = createConversationHarness("local-dev-reset");
  const other = createConversationHarness("local-dev-reset-other");
  let targetProjectId: UuidV7;
  let otherProjectId: UuidV7;

  beforeAll(async () => {
    await target.setUp();
    await other.setUp();
    targetProjectId = target.harness.requireSetup().projectId;
    otherProjectId = other.harness.requireSetup().projectId;
    await seedWork(target);
    await seedWork(other);
  }, 60_000);

  serialTest(
    "deletes the project's runs, Tasks, work items and their children, keeping the project and its definitions",
    async () => {
      const before = await countWork(targetProjectId);
      expect(before).toMatchObject({
        runs: 1,
        tasks: 1,
        taskRuns: 2,
        chainedRuns: 1,
        conversations: 1,
        workItems: 1,
      });
      expect(before.visits).toBeGreaterThan(0);
      expect(before.taskLinkedVisits).toBe(1);
      expect(before.logLines).toBe(1);
      expect(before.messages).toBeGreaterThanOrEqual(2);
      expect(before.notifications).toBeGreaterThan(0);

      const definitionsBefore = await countDefinitions(targetProjectId);
      expect(definitionsBefore.projects).toBe(1);
      expect(definitionsBefore.stepDefinitions).toBeGreaterThan(0);
      expect(definitionsBefore.pipelineGraphs).toBeGreaterThan(0);
      expect(definitionsBefore.pipelineGraphVersions).toBeGreaterThan(0);
      const otherBefore = await countWork(otherProjectId);
      const otherDefinitionsBefore = await countDefinitions(otherProjectId);

      const result = await resetLocalDevProject(
        target.harness.appContext,
        targetProjectId,
      );

      expect(result).toEqual({
        notifications: before.notifications,
        tasks: 1,
        workItems: 1,
      });
      expect(await countWork(targetProjectId)).toEqual({
        runs: 0,
        tasks: 0,
        taskRuns: 0,
        chainedRuns: 0,
        conversations: 0,
        workItems: 0,
        notifications: 0,
        visits: 0,
        taskLinkedVisits: 0,
        logLines: 0,
        messages: 0,
      });
      expect(await countDefinitions(targetProjectId)).toEqual(
        definitionsBefore,
      );
      expect(await countWork(otherProjectId)).toEqual(otherBefore);
      expect(await countDefinitions(otherProjectId)).toEqual(
        otherDefinitionsBefore,
      );
    },
    30_000,
  );

  serialTest(
    "resetting an already empty project is a no-op",
    async () => {
      expect(
        await resetLocalDevProject(target.harness.appContext, targetProjectId),
      ).toEqual({ notifications: 0, tasks: 0, workItems: 0 });
    },
    30_000,
  );

  serialTest("rejects an unknown project", async () => {
    let error: unknown;
    try {
      await resetLocalDevProject(
        target.harness.appContext,
        parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1fff"),
      );
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });
});
