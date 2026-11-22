import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  managedMcpLaunchConnections,
  managedMcpOperations,
  taskRuns,
} from "@/lib/db/schema";
import {
  seedTaskRunParent,
  seedWorkItem,
} from "tests/lib/db/seed-task-prerequisites";

/** Persisted fixtures deliberately keep stale launch rows to exercise maintenance. */
export const seedMaintenanceLaunch = async (input: {
  projectId: string;
  connectionId: string;
  now: Date;
  status: typeof taskRuns.$inferInsert.status;
  completedAt?: Date | null;
  leaseExpiresAt?: Date | null;
  executionDeadlineAt?: Date | null;
  state?: "open" | "closed";
  createdAt?: Date;
  closedAt?: Date;
  operationDeadlineAt?: Date;
}) => {
  const db = getDb();
  const projectId = parseUuidV7(input.projectId);
  const workItemId = await seedWorkItem(projectId);
  const parent = await seedTaskRunParent({ projectId, workItemId });
  const taskRunId = createUuidV7();
  await db.insert(taskRuns).values({
    ...parent,
    id: taskRunId,
    projectId,
    workItemId,
    status: input.status,
    completedAt: input.completedAt ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    executionDeadlineAt: input.executionDeadlineAt ?? null,
  });
  const launchId = createUuidV7();
  const operationId = createUuidV7();
  const operationDeadlineAt =
    input.operationDeadlineAt ?? new Date(input.now.getTime() - 1);
  await db.insert(managedMcpLaunchConnections).values({
    id: launchId,
    taskRunId,
    projectId,
    connectionId: input.connectionId,
    claimTokenDigest: Buffer.from(crypto.randomUUID()),
    capabilityDigest: Buffer.from(crypto.randomUUID()),
    entryKey: "notion",
    generation: 1,
    grantId: createUuidV7(),
    state: input.state ?? "open",
    createdAt: input.createdAt ?? input.now,
    closedAt: input.state === "closed" ? (input.closedAt ?? input.now) : null,
  });
  await db.insert(managedMcpOperations).values({
    id: operationId,
    launchConnectionId: launchId,
    startedAt: new Date(operationDeadlineAt.getTime() - 60_000),
    deadlineAt: operationDeadlineAt,
  });
  return { taskRunId, launchId, operationId };
};
