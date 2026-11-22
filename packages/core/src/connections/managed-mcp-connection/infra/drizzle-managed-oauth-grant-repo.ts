import { and, eq, inArray, isNull, lt, notExists, or } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  managedMcpConnections,
  managedOAuthGrants,
} from "@scarn/core/lib/db/schema";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { ManagedOAuthGrantRepo } from "../application/managed-oauth-grant-repo";
import {
  ManagedOAuthGrantEntity,
  type ManagedOAuthGrantCredentials,
  type ManagedOAuthRefreshClaim,
} from "../domain/managed-oauth-grant-entity";

type ManagedOAuthGrantRow = typeof managedOAuthGrants.$inferSelect;
type ManagedOAuthGrantInsert = typeof managedOAuthGrants.$inferInsert;

const credentialsFromRow = (
  row: ManagedOAuthGrantRow,
): ManagedOAuthGrantCredentials => {
  if (row.retiredAt !== null) {
    return { status: "retired", retiredAt: row.retiredAt };
  }
  if (
    row.credentialsCiphertext === null ||
    row.credentialsIv === null ||
    row.credentialsAuthTag === null ||
    row.credentialsKeyVersion === null
  ) {
    throw new InvariantViolationError(
      `Managed OAuth grant ${row.id} is live but has no credentials`,
    );
  }
  return {
    status: "live",
    encryptedCredentials: {
      ciphertext: Buffer.from(row.credentialsCiphertext),
      iv: Buffer.from(row.credentialsIv),
      authTag: Buffer.from(row.credentialsAuthTag),
      keyVersion: row.credentialsKeyVersion,
    },
  };
};

const credentialColumns = (
  credentials: ManagedOAuthGrantCredentials,
): Pick<
  ManagedOAuthGrantInsert,
  | "credentialsCiphertext"
  | "credentialsIv"
  | "credentialsAuthTag"
  | "credentialsKeyVersion"
  | "retiredAt"
> => {
  switch (credentials.status) {
    case "live":
      return {
        credentialsCiphertext: credentials.encryptedCredentials.ciphertext,
        credentialsIv: credentials.encryptedCredentials.iv,
        credentialsAuthTag: credentials.encryptedCredentials.authTag,
        credentialsKeyVersion: credentials.encryptedCredentials.keyVersion,
        retiredAt: null,
      };
    case "retired":
      return {
        credentialsCiphertext: null,
        credentialsIv: null,
        credentialsAuthTag: null,
        credentialsKeyVersion: null,
        retiredAt: credentials.retiredAt,
      };
  }
};

const refreshClaimFromRow = (
  row: ManagedOAuthGrantRow,
): ManagedOAuthRefreshClaim | null => {
  if (row.refreshClaimId === null || row.refreshClaimedAt === null) {
    return null;
  }
  return {
    claimId: parseUuidV7(row.refreshClaimId),
    claimedAt: row.refreshClaimedAt,
  };
};

const toEntity = (row: ManagedOAuthGrantRow): ManagedOAuthGrantEntity =>
  ManagedOAuthGrantEntity.rehydrate({
    id: parseUuidV7(row.id),
    connectionId: parseUuidV7(row.connectionId),
    projectId: parseUuidV7(row.projectId),
    clientId: row.clientId,
    issuer: row.issuer,
    resource: row.resource,
    credentialVersion: row.credentialVersion,
    credentials: credentialsFromRow(row),
    refreshClaim: refreshClaimFromRow(row),
    encryptedIdentity: {
      ciphertext: Buffer.from(row.identityCiphertext),
      iv: Buffer.from(row.identityIv),
      authTag: Buffer.from(row.identityAuthTag),
      keyVersion: row.identityKeyVersion,
    },
    grantedScopes: row.grantedScopes,
    authorizedAt: row.authorizedAt,
    reconnectBy: row.reconnectBy,
    createdByUserId: parseUuidV7(row.createdByUserId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const toRow = (grant: ManagedOAuthGrantEntity): ManagedOAuthGrantInsert => {
  const props = grant.toJSON();
  return {
    id: props.id,
    connectionId: props.connectionId,
    projectId: props.projectId,
    clientId: props.clientId,
    issuer: props.issuer,
    resource: props.resource,
    credentialVersion: props.credentialVersion,
    ...credentialColumns(props.credentials),
    refreshClaimId: props.refreshClaim?.claimId ?? null,
    refreshClaimedAt: props.refreshClaim?.claimedAt ?? null,
    identityCiphertext: props.encryptedIdentity.ciphertext,
    identityIv: props.encryptedIdentity.iv,
    identityAuthTag: props.encryptedIdentity.authTag,
    identityKeyVersion: props.encryptedIdentity.keyVersion,
    grantedScopes: [...props.grantedScopes],
    authorizedAt: props.authorizedAt,
    reconnectBy: props.reconnectBy,
    createdByUserId: props.createdByUserId,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
};

const mutableColumns = (grant: ManagedOAuthGrantEntity) => {
  const row = toRow(grant);
  return {
    credentialVersion: row.credentialVersion,
    credentialsCiphertext: row.credentialsCiphertext,
    credentialsIv: row.credentialsIv,
    credentialsAuthTag: row.credentialsAuthTag,
    credentialsKeyVersion: row.credentialsKeyVersion,
    retiredAt: row.retiredAt,
    refreshClaimId: row.refreshClaimId,
    refreshClaimedAt: row.refreshClaimedAt,
    updatedAt: row.updatedAt,
  };
};

const scoped = (projectId: UuidV7, connectionId: UuidV7, grantId: UuidV7) =>
  and(
    eq(managedOAuthGrants.id, grantId),
    eq(managedOAuthGrants.connectionId, connectionId),
    eq(managedOAuthGrants.projectId, projectId),
  );

export class DrizzleManagedOAuthGrantRepo implements ManagedOAuthGrantRepo {
  async insert(
    grant: ManagedOAuthGrantEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.insert(managedOAuthGrants).values(toRow(grant));
  }

  async findById(
    projectId: UuidV7,
    connectionId: UuidV7,
    grantId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthGrantEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(managedOAuthGrants)
      .where(scoped(projectId, connectionId, grantId))
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async save(
    grant: ManagedOAuthGrantEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    const updated = await db
      .update(managedOAuthGrants)
      .set(mutableColumns(grant))
      .where(scoped(grant.projectId, grant.connectionId, grant.id))
      .returning({ id: managedOAuthGrants.id });
    if (updated.length !== 1) {
      throw new InvariantViolationError(
        `Managed OAuth grant ${grant.id} not found`,
      );
    }
  }

  async saveIfClaim(
    grant: ManagedOAuthGrantEntity,
    expectedClaimId: UuidV7,
    expectedCredentialVersion: number,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const updated = await db
      .update(managedOAuthGrants)
      .set(mutableColumns(grant))
      .where(
        and(
          scoped(grant.projectId, grant.connectionId, grant.id),
          eq(managedOAuthGrants.refreshClaimId, expectedClaimId),
          eq(managedOAuthGrants.credentialVersion, expectedCredentialVersion),
          isNull(managedOAuthGrants.retiredAt),
        ),
      )
      .returning({ id: managedOAuthGrants.id });
    return updated.length === 1;
  }

  async delete(
    projectId: UuidV7,
    connectionId: UuidV7,
    grantId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(managedOAuthGrants)
      .where(scoped(projectId, connectionId, grantId))
      .returning({ id: managedOAuthGrants.id });
    return rows.length === 1;
  }

  async deleteRetiredBefore(
    input: { retiredBefore: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const batch = db
      .select({ id: managedOAuthGrants.id })
      .from(managedOAuthGrants)
      .where(
        and(
          lt(managedOAuthGrants.retiredAt, input.retiredBefore),
          notExists(
            db
              .select({ id: managedMcpConnections.id })
              .from(managedMcpConnections)
              .where(
                or(
                  eq(
                    managedMcpConnections.activeGrantId,
                    managedOAuthGrants.id,
                  ),
                  eq(
                    managedMcpConnections.candidateGrantId,
                    managedOAuthGrants.id,
                  ),
                ),
              ),
          ),
        ),
      )
      .limit(input.limit);
    const rows = await db
      .delete(managedOAuthGrants)
      .where(inArray(managedOAuthGrants.id, batch))
      .returning({ id: managedOAuthGrants.id });
    return rows.length;
  }
}
