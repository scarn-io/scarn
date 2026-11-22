import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { DbExecutor } from "@/lib/db/db-executor";
import { getDb } from "@/lib/db";
import { tasks, workItems } from "@/lib/db/schema";

export type TaskPrerequisites = {
  workItemId: UuidV7;
};

/** Agent-kind instruction columns that satisfy `tasks_kind_instructions_check`. */
export const agentTaskInstructionColumns = {
  kind: "agent" as const,
  prompt: "Return a result payload.",
};

/** Inserts a bare work item in `projectId` and returns its id. */
export const seedWorkItem = async (
  projectId: UuidV7,
  dbExecutor: DbExecutor = getDb(),
): Promise<UuidV7> => {
  const workItemId = createUuidV7();
  const key = crypto.randomUUID();
  await dbExecutor.insert(workItems).values({
    id: workItemId,
    projectId,
    platform: "github",
    platformKey: `#${key}`,
    title: `Work item ${key}`,
  });
  return workItemId;
};

/**
 * Inserts the rows a raw `tasks` insert must reference: a work item in
 * `projectId`. The task execution config reference is nullable, so tasks and
 * step definitions seeded this way run with the repo's own config. For tests
 * that seed through Drizzle instead of the API.
 */
export const seedTaskPrerequisites = async (
  projectId: UuidV7,
  dbExecutor: DbExecutor = getDb(),
): Promise<TaskPrerequisites> => {
  const workItemId = await seedWorkItem(projectId, dbExecutor);
  return { workItemId };
};

/**
 * Inserts a queued agent Task for a raw `task_runs` insert and returns the
 * run columns that make the run its first (`initial`) run.
 */
export const seedTaskRunParent = async (
  input: { projectId: UuidV7; workItemId: UuidV7 },
  dbExecutor: DbExecutor = getDb(),
): Promise<{ taskId: UuidV7; number: number; reason: "initial" }> => {
  const taskId = createUuidV7();
  await dbExecutor.insert(tasks).values({
    id: taskId,
    projectId: input.projectId,
    workItemId: input.workItemId,
    ...agentTaskInstructionColumns,
    status: "queued",
  });
  return { taskId, number: 1, reason: "initial" };
};
