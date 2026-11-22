/** Seeds runs, log lines and pipeline step visits for the project Tasks list tests. */
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  nodeVisits,
  pipelineGraphs,
  pipelineGraphVersions,
  pipelineRuns,
  taskLogLines,
  taskRuns,
} from "@/lib/db/schema";

/** Inserts a run of `taskId`, with its live log lines. */
export const seedTaskRun = async (input: {
  taskId: UuidV7;
  projectId: UuidV7;
  workItemId: UuidV7;
  number: number;
  status: "running" | "failed" | "succeeded";
  startedAt: Date;
  completedAt?: Date;
  errorJson?: unknown;
  logs?: { stream: "worker" | "conversation"; content: string }[];
}) => {
  const id = createUuidV7();
  await getDb()
    .insert(taskRuns)
    .values({
      id,
      taskId: input.taskId,
      number: input.number,
      reason: input.number === 1 ? "initial" : "retry",
      projectId: input.projectId,
      workItemId: input.workItemId,
      status: input.status,
      errorJson: input.errorJson ?? null,
      startedAt: input.startedAt,
      completedAt: input.completedAt ?? null,
    });
  if (input.logs?.length) {
    await getDb()
      .insert(taskLogLines)
      .values(
        input.logs.map((log, seq) => ({
          id: createUuidV7(),
          taskRunId: id,
          seq,
          stream: log.stream,
          ts: input.startedAt,
          content: log.content,
        })),
      );
  }
  return id;
};

/**
 * Inserts two executions of a `name` pipeline on the work item and a step
 * visit of the second that owns `taskId`.
 */
export const seedPipelineStepVisit = async (input: {
  projectId: UuidV7;
  workItemId: UuidV7;
  taskId: UuidV7;
  name: string;
}) => {
  const db = getDb();
  const pipelineGraphId = createUuidV7();
  const pipelineGraphVersionId = createUuidV7();
  await db.insert(pipelineGraphs).values({
    id: pipelineGraphId,
    projectId: input.projectId,
    key: `filters_graph_${crypto.randomUUID()}`,
    name: input.name,
  });
  await db.insert(pipelineGraphVersions).values({
    id: pipelineGraphVersionId,
    pipelineGraphId,
    version: 1,
    definitionJson: {},
    schemaVersion: 1,
    contentHash: crypto.randomUUID(),
  });
  const runIds = [createUuidV7(), createUuidV7()];
  for (const [index, id] of runIds.entries()) {
    await db.insert(pipelineRuns).values({
      id,
      projectId: input.projectId,
      workItemId: input.workItemId,
      pipelineGraphId,
      pipelineGraphVersionId,
      status: "active",
      createdAt: new Date(Date.UTC(2026, 4, 1, 10, index)),
    });
  }
  await db.insert(nodeVisits).values({
    id: createUuidV7(),
    pipelineRunId: runIds[1] as UuidV7,
    nodeId: "lint",
    nodeKind: "step",
    transitionJson: {},
    status: "active",
    inputJson: {},
    taskId: input.taskId,
    createdAt: new Date(),
  });
};
