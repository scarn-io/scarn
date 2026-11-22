import { desc, eq } from "drizzle-orm";
import { getDb } from "../../lib/db";
import type { DbExecutor } from "../../lib/db/db-executor";
import { authVerifications } from "../../lib/db/schema";
import type { AuthVerificationRepo } from "../application/auth-verification-repo";
import { AuthVerificationEntity } from "../domain/auth-verification-entity";

export class DrizzleAuthVerificationRepo implements AuthVerificationRepo {
  private toEntity(
    row: typeof authVerifications.$inferSelect,
  ): AuthVerificationEntity {
    return new AuthVerificationEntity(
      row.id,
      row.identifier,
      row.value,
      row.expiresAt,
      row.createdAt,
      row.updatedAt,
    );
  }

  async load(
    id: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthVerificationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authVerifications)
      .where(eq(authVerifications.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadLatestByIdentifier(
    identifier: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthVerificationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authVerifications)
      .where(eq(authVerifications.identifier, identifier))
      .orderBy(desc(authVerifications.createdAt))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async save(
    verification: AuthVerificationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AuthVerificationEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(authVerifications)
      .values({
        id: verification.id,
        identifier: verification.identifier,
        value: verification.value,
        expiresAt: verification.expiresAt,
        createdAt: verification.createdAt ?? new Date(),
        updatedAt: verification.updatedAt ?? new Date(),
      })
      .onConflictDoUpdate({
        target: authVerifications.id,
        set: {
          identifier: verification.identifier,
          value: verification.value,
          expiresAt: verification.expiresAt,
          updatedAt: verification.updatedAt ?? new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Failed to save auth verification ${verification.id}`);
    }

    return this.toEntity(row);
  }
}
