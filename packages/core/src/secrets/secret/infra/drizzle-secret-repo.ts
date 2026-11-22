import { and, desc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { secrets } from "@scarn/core/lib/db/schema";
import { isUniqueViolation } from "@scarn/core/lib/db/unique-violation";
import { CoreError, InvariantViolationError } from "@scarn/core/lib/errors";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { anyJsonValueSchema } from "@scarn/core/common/contracts/json";
import type {
  ListSecretsByOwnerOptions,
  SecretRepo,
  SecretSummary,
} from "../application/secret-repo";
import { SecretEntity } from "../domain/secret-entity";
import type { SecretOwner } from "../domain/secret-owner";

type SecretRow = typeof secrets.$inferSelect;

const ownerCondition = (owner: SecretOwner): SQL => {
  switch (owner.type) {
    case "user":
      return eq(secrets.ownerUserId, owner.userId);
    case "project":
      return eq(secrets.ownerProjectId, owner.projectId);
  }
};

const ownerColumns = (owner: SecretOwner) => {
  switch (owner.type) {
    case "user":
      return { ownerUserId: owner.userId, ownerProjectId: null };
    case "project":
      return { ownerUserId: null, ownerProjectId: owner.projectId };
  }
};

const rowOwner = (row: {
  id: string;
  ownerUserId: string | null;
  ownerProjectId: string | null;
}): SecretOwner => {
  if (row.ownerUserId !== null) {
    return { type: "user", userId: parseUuidV7(row.ownerUserId) };
  }
  if (row.ownerProjectId !== null) {
    return { type: "project", projectId: parseUuidV7(row.ownerProjectId) };
  }
  throw new InvariantViolationError(`Secret ${row.id} has no owner`);
};

const toRow = (entity: SecretEntity): typeof secrets.$inferInsert => {
  const row = entity.toJSON();
  return {
    id: row.id,
    ...ownerColumns(row.owner),
    kind: row.kind,
    valueKind: row.valueKind,
    name: row.name,
    metadataJson: row.metadataJson,
    ciphertext: row.encryptedValue.ciphertext,
    iv: row.encryptedValue.iv,
    authTag: row.encryptedValue.authTag,
    keyVersion: row.encryptedValue.keyVersion,
    lastFour: row.lastFour,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const toEntity = (row: SecretRow): SecretEntity =>
  SecretEntity.rehydrate({
    id: parseUuidV7(row.id),
    owner: rowOwner(row),
    kind: row.kind,
    valueKind: row.valueKind,
    name: row.name,
    metadataJson: anyJsonValueSchema.parse(row.metadataJson),
    encryptedValue: {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.authTag),
      keyVersion: row.keyVersion,
    },
    lastFour: row.lastFour,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    updatedByUserId:
      row.updatedByUserId === null ? null : parseUuidV7(row.updatedByUserId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const secretNameTakenError = (owner: SecretOwner) =>
  new CoreError({
    code: "SECRET_NAME_TAKEN",
    message:
      owner.type === "project"
        ? "This project already has a secret with that name."
        : "You already have a key of this kind with that name.",
    status: 409,
  });

export class DrizzleSecretRepo implements SecretRepo {
  async listSummariesByIds(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<SecretSummary[]> {
    if (ids.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        id: secrets.id,
        name: secrets.name,
        ownerUserId: secrets.ownerUserId,
      })
      .from(secrets)
      .where(
        and(inArray(secrets.id, [...ids]), isNotNull(secrets.ownerUserId)),
      );
    return rows.flatMap((row) =>
      row.ownerUserId === null
        ? []
        : [
            {
              id: parseUuidV7(row.id),
              name: row.name,
              ownerUserId: parseUuidV7(row.ownerUserId),
            },
          ],
    );
  }

  async save(
    entity: SecretEntity,
    dbExecutor?: DbExecutor,
  ): Promise<SecretEntity> {
    const db = dbExecutor ?? getDb();
    const values = toRow(entity);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, createdAt, ...updatable } = values;
    try {
      const [row] = await db
        .insert(secrets)
        .values(values)
        .onConflictDoUpdate({ target: secrets.id, set: updatable })
        .returning();
      if (!row) {
        throw new Error("Failed to save secret");
      }
      return toEntity(row);
    } catch (error) {
      if (isUniqueViolation(error as Error)) {
        throw secretNameTakenError(entity.owner);
      }
      throw error;
    }
  }

  async findById(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<SecretEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(secrets)
      .where(eq(secrets.id, id))
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async findByIdForOwner(
    id: UuidV7,
    owner: SecretOwner,
    dbExecutor?: DbExecutor,
  ): Promise<SecretEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), ownerCondition(owner)))
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async listByOwner(
    owner: SecretOwner,
    options?: ListSecretsByOwnerOptions,
    dbExecutor?: DbExecutor,
  ): Promise<SecretEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(secrets)
      .where(
        and(
          ownerCondition(owner),
          options?.kind ? eq(secrets.kind, options.kind) : undefined,
        ),
      )
      .orderBy(desc(secrets.createdAt), desc(secrets.id));
    return rows.map(toEntity);
  }

  async delete(
    id: UuidV7,
    owner: SecretOwner,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const deleted = await db
      .delete(secrets)
      .where(and(eq(secrets.id, id), ownerCondition(owner)))
      .returning({ id: secrets.id });
    return deleted.length > 0;
  }
}
