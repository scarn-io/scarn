import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { managedOAuthAttempts } from "@scarn/core/lib/db/schema";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { EncryptedSecretValue } from "@scarn/core/secrets/secret/domain/encrypted-secret-value";
import type { ManagedOAuthAttemptRepo } from "../application/managed-oauth-attempt-repo";
import {
  ManagedOAuthAttemptEntity,
  managedOAuthAttemptFailureCodeValues,
  type ManagedOAuthAttemptBinding,
  type ManagedOAuthAttemptFailureCode,
  type ManagedOAuthAttemptProgress,
  type ManagedOAuthAttemptStatus,
} from "../domain/managed-oauth-attempt-entity";

type ManagedOAuthAttemptRow = typeof managedOAuthAttempts.$inferSelect;
type ManagedOAuthAttemptInsert = typeof managedOAuthAttempts.$inferInsert;

const verifierFromRow = (row: ManagedOAuthAttemptRow): EncryptedSecretValue => {
  if (
    row.pkceVerifierCiphertext === null ||
    row.pkceVerifierIv === null ||
    row.pkceVerifierAuthTag === null ||
    row.pkceVerifierKeyVersion === null
  ) {
    throw new InvariantViolationError(
      `Managed OAuth attempt ${row.id} is open but has no PKCE verifier`,
    );
  }
  return {
    ciphertext: Buffer.from(row.pkceVerifierCiphertext),
    iv: Buffer.from(row.pkceVerifierIv),
    authTag: Buffer.from(row.pkceVerifierAuthTag),
    keyVersion: row.pkceVerifierKeyVersion,
  };
};

const isFailureCode = (
  value: string,
): value is ManagedOAuthAttemptFailureCode =>
  (managedOAuthAttemptFailureCodeValues as readonly string[]).includes(value);

const bindingFromRow = (
  row: ManagedOAuthAttemptRow,
): ManagedOAuthAttemptBinding => {
  if (
    row.completion === "server_callback" &&
    row.browserSessionDigest !== null
  ) {
    return { kind: "browser", sessionDigest: row.browserSessionDigest };
  }
  if (row.completion === "loopback" && row.completionSecretDigest !== null) {
    return { kind: "loopback", secretDigest: row.completionSecretDigest };
  }
  throw new InvariantViolationError(
    `Managed OAuth attempt ${row.id} has an unknown completion or no binding digest`,
  );
};

const bindingColumns = (
  binding: ManagedOAuthAttemptBinding,
): Pick<
  ManagedOAuthAttemptInsert,
  "completion" | "browserSessionDigest" | "completionSecretDigest"
> => {
  switch (binding.kind) {
    case "browser":
      return {
        completion: "server_callback",
        browserSessionDigest: binding.sessionDigest,
        completionSecretDigest: null,
      };
    case "loopback":
      return {
        completion: "loopback",
        browserSessionDigest: null,
        completionSecretDigest: binding.secretDigest,
      };
  }
};

const progressFromRow = (
  row: ManagedOAuthAttemptRow,
): ManagedOAuthAttemptProgress => {
  switch (row.status) {
    case "pending":
    case "exchanging":
      return {
        status: row.status,
        encryptedPkceVerifier: verifierFromRow(row),
      };
    case "succeeded":
      return {
        status: "succeeded",
        candidateGrantId:
          row.candidateGrantId === null
            ? null
            : parseUuidV7(row.candidateGrantId),
      };
    case "failed":
      if (row.failureCode === null || !isFailureCode(row.failureCode)) {
        throw new InvariantViolationError(
          `Managed OAuth attempt ${row.id} failed without a known failure code`,
        );
      }
      return { status: "failed", failureCode: row.failureCode };
    case "expired":
    case "cancelled":
      return { status: row.status };
  }
};

const progressColumns = (
  progress: ManagedOAuthAttemptProgress,
): Pick<
  ManagedOAuthAttemptInsert,
  | "status"
  | "pkceVerifierCiphertext"
  | "pkceVerifierIv"
  | "pkceVerifierAuthTag"
  | "pkceVerifierKeyVersion"
  | "candidateGrantId"
  | "failureCode"
> => {
  const cleared = {
    pkceVerifierCiphertext: null,
    pkceVerifierIv: null,
    pkceVerifierAuthTag: null,
    pkceVerifierKeyVersion: null,
    candidateGrantId: null,
    failureCode: null,
  };
  switch (progress.status) {
    case "pending":
    case "exchanging":
      return {
        ...cleared,
        status: progress.status,
        pkceVerifierCiphertext: progress.encryptedPkceVerifier.ciphertext,
        pkceVerifierIv: progress.encryptedPkceVerifier.iv,
        pkceVerifierAuthTag: progress.encryptedPkceVerifier.authTag,
        pkceVerifierKeyVersion: progress.encryptedPkceVerifier.keyVersion,
      };
    case "succeeded":
      return {
        ...cleared,
        status: progress.status,
        candidateGrantId: progress.candidateGrantId,
      };
    case "failed":
      return {
        ...cleared,
        status: progress.status,
        failureCode: progress.failureCode,
      };
    case "expired":
    case "cancelled":
      return { ...cleared, status: progress.status };
  }
};

const toEntity = (row: ManagedOAuthAttemptRow): ManagedOAuthAttemptEntity =>
  ManagedOAuthAttemptEntity.rehydrate({
    id: parseUuidV7(row.id),
    connectionId: parseUuidV7(row.connectionId),
    projectId: parseUuidV7(row.projectId),
    kind: row.kind,
    expectedGeneration: row.expectedGeneration,
    actorUserId: parseUuidV7(row.actorUserId),
    binding: bindingFromRow(row),
    stateDigest: row.stateDigest,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    requestedScopes: row.requestedScopes,
    progress: progressFromRow(row),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const toRow = (
  attempt: ManagedOAuthAttemptEntity,
): ManagedOAuthAttemptInsert => {
  const props = attempt.toJSON();
  return {
    id: props.id,
    connectionId: props.connectionId,
    projectId: props.projectId,
    kind: props.kind,
    expectedGeneration: props.expectedGeneration,
    actorUserId: props.actorUserId,
    ...bindingColumns(props.binding),
    stateDigest: props.stateDigest,
    clientId: props.clientId,
    redirectUri: props.redirectUri,
    requestedScopes: [...props.requestedScopes],
    ...progressColumns(props.progress),
    expiresAt: props.expiresAt,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
};

export class DrizzleManagedOAuthAttemptRepo implements ManagedOAuthAttemptRepo {
  async insert(
    attempt: ManagedOAuthAttemptEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.insert(managedOAuthAttempts).values(toRow(attempt));
  }

  async findByStateDigest(
    stateDigest: string,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(managedOAuthAttempts)
      .where(eq(managedOAuthAttempts.stateDigest, stateDigest))
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async findByCandidateGrant(
    projectId: UuidV7,
    candidateGrantId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(managedOAuthAttempts)
      .where(
        and(
          eq(managedOAuthAttempts.projectId, projectId),
          eq(managedOAuthAttempts.candidateGrantId, candidateGrantId),
        ),
      )
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async saveIfStatus(
    attempt: ManagedOAuthAttemptEntity,
    expectedStatus: ManagedOAuthAttemptStatus,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const row = toRow(attempt);
    const rows = await db
      .update(managedOAuthAttempts)
      .set({
        ...progressColumns(attempt.progress),
        updatedAt: row.updatedAt,
      })
      .where(
        and(
          eq(managedOAuthAttempts.id, attempt.id),
          eq(managedOAuthAttempts.projectId, attempt.projectId),
          eq(managedOAuthAttempts.status, expectedStatus),
        ),
      )
      .returning({ id: managedOAuthAttempts.id });
    return rows.length === 1;
  }

  async listOpenByConnection(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(managedOAuthAttempts)
      .where(
        and(
          eq(managedOAuthAttempts.projectId, projectId),
          eq(managedOAuthAttempts.connectionId, connectionId),
          inArray(managedOAuthAttempts.status, ["pending", "exchanging"]),
        ),
      )
      .orderBy(asc(managedOAuthAttempts.createdAt));
    return rows.map(toEntity);
  }

  async listLapsedOpen(
    input: { now: Date; exchangingBefore: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(managedOAuthAttempts)
      .where(
        or(
          and(
            eq(managedOAuthAttempts.status, "pending"),
            lte(managedOAuthAttempts.expiresAt, input.now),
          ),
          and(
            eq(managedOAuthAttempts.status, "exchanging"),
            lte(managedOAuthAttempts.updatedAt, input.exchangingBefore),
          ),
        ),
      )
      .orderBy(asc(managedOAuthAttempts.expiresAt))
      .limit(input.limit);
    return rows.map(toEntity);
  }
}
