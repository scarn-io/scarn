import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { GrantRequest } from "../domain/grant-request";

export interface GrantRequestRepo {
  /**
   * Inserts a request. Throws `GRANT_REQUEST_ALREADY_PENDING` when its Task
   * already has a `pending` one.
   */
  insert(request: GrantRequest, dbExecutor?: DbExecutor): Promise<GrantRequest>;
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<GrantRequest | null>;
  /** The Task's requests, oldest first. */
  listByTaskId(
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<GrantRequest[]>;
  /** The Task's `pending` request, if any, locked for update. */
  findPendingByTaskId(
    taskId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<GrantRequest | null>;
  /** Writes the request's status and decision. */
  save(request: GrantRequest, dbExecutor?: DbExecutor): Promise<GrantRequest>;
}
