import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { managedConnectionEvents } from "@scarn/core/lib/db/schema";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { ManagedConnectionEventRepo } from "../application/managed-connection-event-repo";
import { isManagedConnectionReasonCode } from "../domain/managed-connection-entity";
import {
  managedRefreshFailureCodeValues,
  type ManagedConnectionEvent,
} from "../domain/managed-connection-event";
import { managedAuthorityLossReasonValues } from "../domain/managed-launch-connection-entity";
import { managedOAuthAttemptFailureCodeValues } from "../domain/managed-oauth-attempt-entity";

type ManagedConnectionEventRow = typeof managedConnectionEvents.$inferSelect;

const reasonCodeFromRow = (
  row: ManagedConnectionEventRow,
): ManagedConnectionEvent["reasonCode"] => {
  const { reasonCode } = row;
  if (reasonCode === null || isManagedConnectionReasonCode(reasonCode)) {
    return reasonCode;
  }
  const failureCode =
    managedOAuthAttemptFailureCodeValues.find(
      (value) => value === reasonCode,
    ) ??
    managedRefreshFailureCodeValues.find((value) => value === reasonCode) ??
    managedAuthorityLossReasonValues.find((value) => value === reasonCode);
  if (failureCode === undefined) {
    throw new InvariantViolationError(
      `Managed connection event ${row.id} has an unknown reason code`,
    );
  }
  return failureCode;
};

const toEvent = (row: ManagedConnectionEventRow): ManagedConnectionEvent => ({
  id: parseUuidV7(row.id),
  projectId: parseUuidV7(row.projectId),
  connectionId: parseUuidV7(row.connectionId),
  actorUserId: row.actorUserId === null ? null : parseUuidV7(row.actorUserId),
  taskRunId: row.taskRunId === null ? null : parseUuidV7(row.taskRunId),
  type: row.type,
  generation: row.generation,
  reasonCode: reasonCodeFromRow(row),
  revocationOutcome: row.revocationOutcome,
  sameIdentityAsActive: row.sameIdentityAsActive,
  createdAt: row.createdAt,
});

export class DrizzleManagedConnectionEventRepo implements ManagedConnectionEventRepo {
  async append(
    event: ManagedConnectionEvent,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.insert(managedConnectionEvents).values(event);
  }

  async listByConnection(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEvent[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(managedConnectionEvents)
      .where(
        and(
          eq(managedConnectionEvents.projectId, projectId),
          eq(managedConnectionEvents.connectionId, connectionId),
        ),
      )
      .orderBy(desc(managedConnectionEvents.createdAt));
    return rows.map(toEvent);
  }

  async deleteCreatedBefore(
    input: { createdBefore: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const batch = db
      .select({ id: managedConnectionEvents.id })
      .from(managedConnectionEvents)
      .where(lt(managedConnectionEvents.createdAt, input.createdBefore))
      .limit(input.limit);
    const rows = await db
      .delete(managedConnectionEvents)
      .where(inArray(managedConnectionEvents.id, batch))
      .returning({ id: managedConnectionEvents.id });
    return rows.length;
  }
}
