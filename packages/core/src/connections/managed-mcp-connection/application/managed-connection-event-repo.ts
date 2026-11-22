import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ManagedConnectionEvent } from "../domain/managed-connection-event";

export interface ManagedConnectionEventRepo {
  append(event: ManagedConnectionEvent, dbExecutor?: DbExecutor): Promise<void>;
  /** Newest first. */
  listByConnection(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEvent[]>;
  /**
   * Maintenance, across projects: deletes up to `limit` events created before
   * `createdBefore`. Returns how many it deleted.
   */
  deleteCreatedBefore(
    input: { createdBefore: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<number>;
}
