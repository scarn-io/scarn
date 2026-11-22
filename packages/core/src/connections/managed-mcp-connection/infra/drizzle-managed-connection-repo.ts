import { and, asc, eq, gt, lte, or, type SQL } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  managedMcpConnections,
  managedOAuthGrants,
} from "@scarn/core/lib/db/schema";
import { isUniqueViolation } from "@scarn/core/lib/db/unique-violation";
import { CoreError, InvariantViolationError } from "@scarn/core/lib/errors";
import type { ManagedConnectionRepo } from "../application/managed-connection-repo";
import {
  isManagedConnectionReasonCode,
  ManagedConnectionEntity,
  type ManagedConnectionReasonCode,
} from "../domain/managed-connection-entity";
import {
  managedConnectionClientRegistrationSchema,
  type ManagedConnectionServer,
} from "../domain/managed-connection-server";
import {
  managedConnectionDiscoverySchema,
  type ManagedConnectionDiscovery,
} from "../domain/managed-connection-discovery";

type ManagedConnectionRow = typeof managedMcpConnections.$inferSelect;

const optionalUuid = (value: string | null): UuidV7 | null =>
  value === null ? null : parseUuidV7(value);

const reasonCodeFromRow = (
  row: ManagedConnectionRow,
): ManagedConnectionReasonCode | null => {
  if (row.reasonCode === null) {
    return null;
  }
  if (!isManagedConnectionReasonCode(row.reasonCode)) {
    throw new InvariantViolationError(
      `Managed connection ${row.id} has an unknown reason code`,
    );
  }
  return row.reasonCode;
};

const discoveryFromRow = (
  row: ManagedConnectionRow,
): { discovery?: ManagedConnectionDiscovery } => {
  const parsed = managedConnectionDiscoverySchema.safeParse(row.discovery);
  if (!parsed.success) {
    throw new InvariantViolationError(
      `Managed connection ${row.id} has invalid discovery overrides`,
    );
  }
  return Object.keys(parsed.data).length === 0
    ? {}
    : { discovery: parsed.data };
};

const serverFromRow = (row: ManagedConnectionRow): ManagedConnectionServer => {
  const base = {
    resource: row.resource,
    issuerOrigin: row.issuerOrigin,
    ...discoveryFromRow(row),
    ...(row.scopes === null ? {} : { scopes: row.scopes }),
  };
  const clientRegistration = managedConnectionClientRegistrationSchema.parse(
    row.clientRegistration,
  );
  if (clientRegistration !== "supplied") {
    return { ...base, clientRegistration };
  }
  if (row.suppliedClientId === null || row.suppliedRedirectUri === null) {
    throw new InvariantViolationError(
      `Managed connection ${row.id} is supplied but has no client`,
    );
  }
  return {
    ...base,
    clientRegistration,
    suppliedClientId: row.suppliedClientId,
    suppliedRedirectUri: row.suppliedRedirectUri,
  };
};

const serverToRow = (
  server: ManagedConnectionServer,
): Pick<
  typeof managedMcpConnections.$inferInsert,
  | "resource"
  | "issuerOrigin"
  | "clientRegistration"
  | "suppliedClientId"
  | "suppliedRedirectUri"
  | "discovery"
  | "scopes"
> => ({
  resource: server.resource,
  issuerOrigin: server.issuerOrigin,
  discovery: server.discovery ?? {},
  scopes: server.scopes === undefined ? null : [...server.scopes],
  clientRegistration: server.clientRegistration,
  suppliedClientId:
    server.clientRegistration === "supplied" ? server.suppliedClientId : null,
  suppliedRedirectUri:
    server.clientRegistration === "supplied"
      ? server.suppliedRedirectUri
      : null,
});

const toEntity = (row: ManagedConnectionRow): ManagedConnectionEntity =>
  ManagedConnectionEntity.rehydrate({
    id: parseUuidV7(row.id),
    projectId: parseUuidV7(row.projectId),
    name: row.name,
    label: row.label,
    preset: row.preset,
    server: serverFromRow(row),
    state: row.state,
    reasonCode: reasonCodeFromRow(row),
    generation: row.generation,
    version: row.version,
    activeGrantId: optionalUuid(row.activeGrantId),
    candidateGrantId: optionalUuid(row.candidateGrantId),
    connectedByUserId: optionalUuid(row.connectedByUserId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const toRow = (
  entity: ManagedConnectionEntity,
): typeof managedMcpConnections.$inferInsert => {
  const { server, ...rest } = entity.toJSON();
  return { ...rest, ...serverToRow(server) };
};

const connectionExists = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_EXISTS",
    message: "This project already has a connection with this name or MCP URL.",
    status: 409,
  });

export class DrizzleManagedConnectionRepo implements ManagedConnectionRepo {
  async findById(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(managedMcpConnections)
      .where(
        and(
          eq(managedMcpConnections.id, connectionId),
          eq(managedMcpConnections.projectId, projectId),
        ),
      )
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async listByProject(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(managedMcpConnections)
      .where(eq(managedMcpConnections.projectId, projectId))
      .orderBy(asc(managedMcpConnections.createdAt));
    return rows.map(toEntity);
  }

  async loadForUpdate(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedConnectionEntity | null> {
    const [row] = await dbExecutor
      .select()
      .from(managedMcpConnections)
      .where(
        and(
          eq(managedMcpConnections.id, connectionId),
          eq(managedMcpConnections.projectId, projectId),
        ),
      )
      .limit(1)
      .for("update");
    return row ? toEntity(row) : null;
  }

  async loadForShare(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedConnectionEntity | null> {
    const [row] = await dbExecutor
      .select()
      .from(managedMcpConnections)
      .where(
        and(
          eq(managedMcpConnections.id, connectionId),
          eq(managedMcpConnections.projectId, projectId),
        ),
      )
      .limit(1)
      .for("share");
    return row ? toEntity(row) : null;
  }

  async loadByName(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity | null> {
    return await this.loadOneWhere(
      projectId,
      eq(managedMcpConnections.name, name),
      dbExecutor ?? getDb(),
    );
  }

  async loadByNameForUpdate(
    projectId: UuidV7,
    name: string,
    dbExecutor: DbExecutor,
  ): Promise<ManagedConnectionEntity | null> {
    const [row] = await dbExecutor
      .select()
      .from(managedMcpConnections)
      .where(
        and(
          eq(managedMcpConnections.projectId, projectId),
          eq(managedMcpConnections.name, name),
        ),
      )
      .limit(1)
      .for("update");
    return row ? toEntity(row) : null;
  }

  async loadByResource(
    projectId: UuidV7,
    resource: string,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedConnectionEntity | null> {
    return await this.loadOneWhere(
      projectId,
      eq(managedMcpConnections.resource, resource),
      dbExecutor ?? getDb(),
    );
  }

  async insert(
    entity: ManagedConnectionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    try {
      await db.insert(managedMcpConnections).values(toRow(entity));
    } catch (error) {
      if (isUniqueViolation(error as Error)) {
        throw connectionExists();
      }
      throw error;
    }
  }

  async saveIfVersion(
    entity: ManagedConnectionEntity,
    expectedVersion: number,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const row = entity.toJSON();
    const rows = await db
      .update(managedMcpConnections)
      .set({
        state: row.state,
        reasonCode: row.reasonCode,
        generation: row.generation,
        version: row.version,
        activeGrantId: row.activeGrantId,
        candidateGrantId: row.candidateGrantId,
        connectedByUserId: row.connectedByUserId,
        updatedAt: row.updatedAt,
      })
      .where(
        and(
          eq(managedMcpConnections.id, entity.id),
          eq(managedMcpConnections.projectId, entity.projectId),
          eq(managedMcpConnections.version, expectedVersion),
        ),
      )
      .returning({ id: managedMcpConnections.id });
    return rows.length === 1;
  }

  async listLapsed(
    input: { startedBefore: Date; afterId: UuidV7 | null; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<{ projectId: UuidV7; connectionId: UuidV7 }[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        projectId: managedMcpConnections.projectId,
        connectionId: managedMcpConnections.id,
      })
      .from(managedMcpConnections)
      .leftJoin(
        managedOAuthGrants,
        eq(managedOAuthGrants.id, managedMcpConnections.candidateGrantId),
      )
      .where(
        and(
          input.afterId === null
            ? undefined
            : gt(managedMcpConnections.id, input.afterId),
          or(
            and(
              eq(managedMcpConnections.state, "connecting"),
              lte(managedMcpConnections.updatedAt, input.startedBefore),
            ),
            lte(managedOAuthGrants.createdAt, input.startedBefore),
          ),
        ),
      )
      .orderBy(asc(managedMcpConnections.id))
      .limit(input.limit);
    return rows.map((row) => ({
      projectId: parseUuidV7(row.projectId),
      connectionId: parseUuidV7(row.connectionId),
    }));
  }

  private async loadOneWhere(
    projectId: UuidV7,
    condition: SQL,
    db: DbExecutor,
  ): Promise<ManagedConnectionEntity | null> {
    const [row] = await db
      .select()
      .from(managedMcpConnections)
      .where(and(eq(managedMcpConnections.projectId, projectId), condition))
      .limit(1);
    return row ? toEntity(row) : null;
  }
}
