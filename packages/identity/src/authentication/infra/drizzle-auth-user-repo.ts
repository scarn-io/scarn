import { eq } from "drizzle-orm";
import { getDb } from "../../lib/db";
import type { DbExecutor } from "../../lib/db/db-executor";
import { authUsers } from "../../lib/db/schema";
import type { AuthUserRepo } from "../application/auth-user-repo";
import { AuthUserEntity } from "../domain/auth-user-entity";

export class DrizzleAuthUserRepo implements AuthUserRepo {
  private toEntity(row: typeof authUsers.$inferSelect): AuthUserEntity {
    return new AuthUserEntity(
      row.id,
      row.email,
      row.username,
      row.name,
      row.emailVerified,
      row.usernameChosen,
      row.image,
      row.createdAt,
      row.updatedAt,
    );
  }

  async load(id: string, dbExecutor?: DbExecutor): Promise<AuthUserEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadByEmail(
    email: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthUserEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadByUsername(
    username: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthUserEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.username, username))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async isUsernameTaken(
    username: string,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.username, username))
      .limit(1);

    return row !== undefined;
  }

  async save(
    user: AuthUserEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AuthUserEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(authUsers)
      .values({
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        emailVerified: user.emailVerified,
        usernameChosen: user.usernameChosen,
        image: user.image,
        createdAt: user.createdAt ?? new Date(),
        updatedAt: user.updatedAt ?? new Date(),
      })
      // `username` and `usernameChosen` are deliberately absent from the update
      // branch: an upsert over an existing row PRESERVES the handle the user
      // chose rather than reverting it to whatever the caller happened to
      // construct the entity with.
      //
      // Two reasons. The handle is claimed through `POST /username`, which goes
      // via Better Auth's `updateUser` so the signed `session.cookieCache`
      // snapshot is re-signed in the same response. A write here would bypass
      // that and leave the cached `username`/`usernameChosen` stale for up to
      // `cookieCache.maxAge`, which is exactly what the onboarding gate in
      // `(protected)/layout.tsx` branches on. And a stale `usernameChosen: false`
      // sends an onboarded user back to the username screen, where re-claiming
      // their own handle 409s — so the two columns have to move together.
      //
      // The row from `.returning()` therefore reports the PRESERVED handle, not
      // the one passed in; callers see the truth rather than a silent no-op.
      .onConflictDoUpdate({
        target: authUsers.id,
        set: {
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
          image: user.image,
          updatedAt: user.updatedAt ?? new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Failed to save auth user ${user.id}`);
    }

    return this.toEntity(row);
  }
}
