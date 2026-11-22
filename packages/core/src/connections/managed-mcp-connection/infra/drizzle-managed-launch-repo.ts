import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  exists,
  inArray,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  managedMcpLaunchConnections,
  managedMcpOperations,
  taskRuns,
} from "@scarn/core/lib/db/schema";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type {
  ManagedLaunchRepo,
  ManagedRunOperation,
} from "../application/managed-launch-repo";
import {
  MANAGED_LAUNCH_MAX_OPEN_OPERATIONS,
  ManagedLaunchConnectionEntity,
  type ManagedOperation,
} from "../domain/managed-launch-connection-entity";

type LaunchConnectionRow = typeof managedMcpLaunchConnections.$inferSelect;

const terminalRun = inArray(taskRuns.status, [
  "succeeded",
  "failed",
  "timeout",
  "abandoned",
  "cancelled",
  "skipped",
  "yielded",
]);

const toEntity = (row: LaunchConnectionRow): ManagedLaunchConnectionEntity =>
  ManagedLaunchConnectionEntity.rehydrate({
    id: parseUuidV7(row.id),
    projectId: parseUuidV7(row.projectId),
    taskRunId: parseUuidV7(row.taskRunId),
    claimTokenDigest: row.claimTokenDigest,
    entryKey: row.entryKey,
    connectionId: parseUuidV7(row.connectionId),
    generation: row.generation,
    grantId: parseUuidV7(row.grantId),
    capabilityDigest: row.capabilityDigest,
    mcpSessionIdDigest: row.mcpSessionIdDigest,
    state: row.state,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  });

export class DrizzleManagedLaunchRepo implements ManagedLaunchRepo {
  async upsertOpen(
    entity: ManagedLaunchConnectionEntity,
    dbExecutor: DbExecutor,
  ): Promise<ManagedLaunchConnectionEntity> {
    const row = entity.toJSON();
    const [stored] = await dbExecutor
      .insert(managedMcpLaunchConnections)
      .values(row)
      .onConflictDoUpdate({
        target: [
          managedMcpLaunchConnections.taskRunId,
          managedMcpLaunchConnections.claimTokenDigest,
          managedMcpLaunchConnections.entryKey,
        ],
        set: {
          connectionId: row.connectionId,
          generation: row.generation,
          grantId: row.grantId,
          capabilityDigest: row.capabilityDigest,
          mcpSessionIdDigest: null,
          state: "open",
          closedAt: null,
        },
      })
      .returning();
    if (!stored) {
      throw new InvariantViolationError(
        `Upserting managed launch connection ${entity.id} returned no row`,
      );
    }
    return toEntity(stored);
  }

  async loadByCapabilityDigest(
    capabilityDigest: Buffer,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedLaunchConnectionEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(managedMcpLaunchConnections)
      .where(eq(managedMcpLaunchConnections.capabilityDigest, capabilityDigest))
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async listOpenForRun(
    taskRunId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedLaunchConnectionEntity[]> {
    const rows = await dbExecutor
      .select()
      .from(managedMcpLaunchConnections)
      .where(
        and(
          eq(managedMcpLaunchConnections.taskRunId, taskRunId),
          eq(managedMcpLaunchConnections.state, "open"),
        ),
      )
      .orderBy(asc(managedMcpLaunchConnections.entryKey));
    return rows.map(toEntity);
  }

  async countOpenRunsForConnection(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ value: countDistinct(managedMcpLaunchConnections.taskRunId) })
      .from(managedMcpLaunchConnections)
      .where(
        and(
          eq(managedMcpLaunchConnections.projectId, projectId),
          eq(managedMcpLaunchConnections.connectionId, connectionId),
          eq(managedMcpLaunchConnections.state, "open"),
        ),
      );
    return row?.value ?? 0;
  }

  async saveSessionBinding(
    entity: ManagedLaunchConnectionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .update(managedMcpLaunchConnections)
      .set({ mcpSessionIdDigest: entity.mcpSessionIdDigest })
      .where(
        and(
          eq(managedMcpLaunchConnections.id, entity.id),
          eq(managedMcpLaunchConnections.state, "open"),
        ),
      )
      .returning({ id: managedMcpLaunchConnections.id });
    return rows.length === 1;
  }

  async closeAllForRun(
    taskRunId: UuidV7,
    now: Date,
    dbExecutor: DbExecutor,
  ): Promise<number> {
    const rows = await dbExecutor
      .update(managedMcpLaunchConnections)
      .set({ state: "closed", closedAt: now })
      .where(
        and(
          eq(managedMcpLaunchConnections.taskRunId, taskRunId),
          eq(managedMcpLaunchConnections.state, "open"),
        ),
      )
      .returning({ id: managedMcpLaunchConnections.id });
    return rows.length;
  }

  async closeTerminalLaunches(input: {
    now: Date;
    limit: number;
  }): Promise<number> {
    const db = getDb();
    const eligible = and(
      eq(managedMcpLaunchConnections.state, "open"),
      exists(
        db
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.id, managedMcpLaunchConnections.taskRunId),
              or(
                terminalRun,
                and(
                  eq(taskRuns.status, "running"),
                  or(
                    lte(taskRuns.leaseExpiresAt, input.now),
                    lte(taskRuns.executionDeadlineAt, input.now),
                  ),
                ),
              ),
            ),
          ),
      ),
    );
    const batch = db
      .select({ id: managedMcpLaunchConnections.id })
      .from(managedMcpLaunchConnections)
      .where(eligible)
      .orderBy(asc(managedMcpLaunchConnections.id))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    const rows = await db
      .update(managedMcpLaunchConnections)
      .set({ state: "closed", closedAt: input.now })
      .where(inArray(managedMcpLaunchConnections.id, batch))
      .returning({ id: managedMcpLaunchConnections.id });
    return rows.length;
  }

  async deleteEndedRunLaunchesBefore(input: {
    endedBefore: Date;
    limit: number;
  }): Promise<number> {
    const db = getDb();
    const batch = db
      .select({ id: managedMcpLaunchConnections.id })
      .from(managedMcpLaunchConnections)
      .where(
        and(
          eq(managedMcpLaunchConnections.state, "closed"),
          exists(
            db
              .select({ id: taskRuns.id })
              .from(taskRuns)
              .where(
                and(
                  eq(taskRuns.id, managedMcpLaunchConnections.taskRunId),
                  terminalRun,
                  lt(taskRuns.completedAt, input.endedBefore),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(managedMcpLaunchConnections.id))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    const rows = await db
      .delete(managedMcpLaunchConnections)
      .where(inArray(managedMcpLaunchConnections.id, batch))
      .returning({ id: managedMcpLaunchConnections.id });
    return rows.length;
  }

  /**
   * Lock, count and insert are separate statements so the count runs on a
   * snapshot taken after the lock is held; a single `INSERT ... SELECT`
   * would count on a snapshot from before it waited.
   */
  async insertOperation(
    operation: ManagedOperation,
    dbExecutor: DbExecutor,
  ): Promise<boolean> {
    return dbExecutor.transaction(async (tx) => {
      const [launch] = await tx
        .select({ id: managedMcpLaunchConnections.id })
        .from(managedMcpLaunchConnections)
        .where(
          and(
            eq(managedMcpLaunchConnections.id, operation.launchConnectionId),
            eq(managedMcpLaunchConnections.state, "open"),
          ),
        )
        .limit(1)
        .for("update");
      if (!launch) {
        return false;
      }
      const [open] = await tx
        .select({ value: count() })
        .from(managedMcpOperations)
        .where(
          eq(
            managedMcpOperations.launchConnectionId,
            operation.launchConnectionId,
          ),
        );
      if ((open?.value ?? 0) >= MANAGED_LAUNCH_MAX_OPEN_OPERATIONS) {
        return false;
      }
      await tx.insert(managedMcpOperations).values(operation);
      return true;
    });
  }

  async deleteOperation(
    operationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .delete(managedMcpOperations)
      .where(eq(managedMcpOperations.id, operationId));
  }

  async listOperations(
    taskRunId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedRunOperation[]> {
    return await this.selectOperations(
      eq(managedMcpLaunchConnections.taskRunId, taskRunId),
      dbExecutor,
    );
  }

  /** Lock and list are separate statements, so the list sees what committed while the lock was awaited. */
  async lockOperationsForSeal(
    taskRunId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedRunOperation[]> {
    const openForRun = and(
      eq(managedMcpLaunchConnections.taskRunId, taskRunId),
      eq(managedMcpLaunchConnections.state, "open"),
    );
    const locked = await dbExecutor
      .select({ id: managedMcpLaunchConnections.id })
      .from(managedMcpLaunchConnections)
      .where(openForRun)
      .orderBy(asc(managedMcpLaunchConnections.id))
      .for("update");
    if (locked.length === 0) {
      return [];
    }
    return await this.selectOperations(openForRun, dbExecutor);
  }

  private async selectOperations(
    where: SQL | undefined,
    dbExecutor: DbExecutor,
  ): Promise<ManagedRunOperation[]> {
    const rows = await dbExecutor
      .select({
        id: managedMcpOperations.id,
        launchConnectionId: managedMcpOperations.launchConnectionId,
        connectionId: managedMcpLaunchConnections.connectionId,
        startedAt: managedMcpOperations.startedAt,
        deadlineAt: managedMcpOperations.deadlineAt,
      })
      .from(managedMcpOperations)
      .innerJoin(
        managedMcpLaunchConnections,
        eq(
          managedMcpLaunchConnections.id,
          managedMcpOperations.launchConnectionId,
        ),
      )
      .where(where)
      .orderBy(asc(managedMcpOperations.startedAt));
    return rows.map((row) => ({
      id: parseUuidV7(row.id),
      launchConnectionId: parseUuidV7(row.launchConnectionId),
      connectionId: parseUuidV7(row.connectionId),
      startedAt: row.startedAt,
      deadlineAt: row.deadlineAt,
    }));
  }
}
