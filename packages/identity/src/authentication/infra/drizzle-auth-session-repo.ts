import { eq } from "drizzle-orm";
import { getDb } from "../../lib/db";
import type { DbExecutor } from "../../lib/db/db-executor";
import { authSessions } from "../../lib/db/schema";
import type { AuthSessionRepo } from "../application/auth-session-repo";
import { AuthSessionEntity } from "../domain/auth-session-entity";

export class DrizzleAuthSessionRepo implements AuthSessionRepo {
  private toEntity(row: typeof authSessions.$inferSelect): AuthSessionEntity {
    return new AuthSessionEntity(
      row.id,
      row.userId,
      row.token,
      row.expiresAt,
      row.ipAddress,
      row.userAgent,
      row.createdAt,
      row.updatedAt,
    );
  }

  async load(
    id: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthSessionEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadByToken(
    token: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthSessionEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.token, token))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async save(
    session: AuthSessionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AuthSessionEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(authSessions)
      .values({
        id: session.id,
        userId: session.userId,
        token: session.token,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt ?? new Date(),
        updatedAt: session.updatedAt ?? new Date(),
      })
      .onConflictDoUpdate({
        target: authSessions.id,
        set: {
          userId: session.userId,
          token: session.token,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          updatedAt: session.updatedAt ?? new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Failed to save auth session ${session.id}`);
    }

    return this.toEntity(row);
  }
}
