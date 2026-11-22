import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";

/**
 * Every read is scoped to a project in the query itself, so a connection ID
 * from another project behaves exactly like a missing one. Transitions are
 * saved with compare-and-set on `version`.
 */
export interface ManagedConnectionRepo {
  findById(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity | null>;
  listByProject(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity[]>;
  /** Locks the row (`FOR UPDATE`) for the rest of the transaction. */
  loadForUpdate(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedConnectionEntity | null>;
  /**
   * Locks the row `FOR SHARE` for the rest of the transaction, so concurrent
   * readers (launch registration, the authority fence) don't block each
   * other but any transition (`FOR UPDATE`) waits for them, and vice versa.
   */
  loadForShare(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedConnectionEntity | null>;
  /** The project's connection with this name, if it has one. */
  loadByName(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity | null>;
  /** Locks the project's connection with this name, if it has one. */
  loadByNameForUpdate(
    projectId: UuidV7,
    name: string,
    dbExecutor: DbExecutor,
  ): Promise<ManagedConnectionEntity | null>;
  /** The project's connection to this normalized MCP URL, if it has one. */
  loadByResource(
    projectId: UuidV7,
    resource: string,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity | null>;
  /**
   * Inserts a new connection. Throws `MANAGED_CONNECTION_EXISTS` (409) when
   * the project already has one with the same name or MCP URL.
   */
  insert(
    entity: ManagedConnectionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /**
   * Writes `entity` only if the stored row is still at `expectedVersion`.
   * Returns false, and writes nothing, when someone else moved it first.
   */
  saveIfVersion(
    entity: ManagedConnectionEntity,
    expectedVersion: number,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  /**
   * Maintenance, across projects: connections still `connecting` since
   * before `startedBefore`, or holding a candidate grant stored before
   * `startedBefore`. Ordered by ID, after `afterId` when given, at most
   * `limit`.
   */
  listLapsed(
    input: { startedBefore: Date; afterId: UuidV7 | null; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<{ projectId: UuidV7; connectionId: UuidV7 }[]>;
}
