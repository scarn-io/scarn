import type { DbExecutor } from "../../lib/db/db-executor";
import type { AuthUserEntity } from "../domain/auth-user-entity";

export type AuthUserRepo = {
  load(id: string, dbExecutor?: DbExecutor): Promise<AuthUserEntity | null>;
  loadByEmail(
    email: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthUserEntity | null>;
  loadByUsername(
    username: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthUserEntity | null>;
  isUsernameTaken(
    username: string,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  /**
   * Insert the user, or update an existing row with the same id.
   *
   * `username` and `usernameChosen` are write-once: they are set on insert and
   * PRESERVED on update, so this cannot revert a handle the user has claimed.
   * Changing a handle goes through `POST /username`, which writes via Better
   * Auth so the cached session snapshot is re-signed alongside the row. The
   * returned entity reflects the stored row, so a caller that passes a
   * different handle sees the preserved one back.
   */
  save(user: AuthUserEntity, dbExecutor?: DbExecutor): Promise<AuthUserEntity>;
};
