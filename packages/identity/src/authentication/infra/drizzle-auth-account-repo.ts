import { and, eq } from "drizzle-orm";
import { getDb } from "../../lib/db";
import type { DbExecutor } from "../../lib/db/db-executor";
import { authAccounts } from "../../lib/db/schema";
import type { AuthAccountRepo } from "../application/auth-account-repo";
import { AuthAccountEntity } from "../domain/auth-account-entity";

export class DrizzleAuthAccountRepo implements AuthAccountRepo {
  private toEntity(row: typeof authAccounts.$inferSelect): AuthAccountEntity {
    return new AuthAccountEntity(
      row.id,
      row.accountId,
      row.providerId,
      row.userId,
      row.accessToken,
      row.refreshToken,
      row.idToken,
      row.accessTokenExpiresAt,
      row.refreshTokenExpiresAt,
      row.scope,
      row.createdAt,
      row.updatedAt,
    );
  }

  async load(id: string, dbExecutor?: DbExecutor): Promise<AuthAccountEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadByProviderAccount(
    providerId: string,
    accountId: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthAccountEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.providerId, providerId),
          eq(authAccounts.accountId, accountId),
        ),
      )
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadByUserId(
    userId: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthAccountEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, userId));

    return rows.map((row) => this.toEntity(row));
  }

  async save(
    account: AuthAccountEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AuthAccountEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(authAccounts)
      .values({
        id: account.id,
        accountId: account.accountId,
        providerId: account.providerId,
        userId: account.userId,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
        accessTokenExpiresAt: account.accessTokenExpiresAt,
        refreshTokenExpiresAt: account.refreshTokenExpiresAt,
        scope: account.scope,
        createdAt: account.createdAt ?? new Date(),
        updatedAt: account.updatedAt ?? new Date(),
      })
      .onConflictDoUpdate({
        target: authAccounts.id,
        set: {
          accountId: account.accountId,
          providerId: account.providerId,
          userId: account.userId,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          idToken: account.idToken,
          accessTokenExpiresAt: account.accessTokenExpiresAt,
          refreshTokenExpiresAt: account.refreshTokenExpiresAt,
          scope: account.scope,
          updatedAt: account.updatedAt ?? new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Failed to save auth account ${account.id}`);
    }

    return this.toEntity(row);
  }
}
