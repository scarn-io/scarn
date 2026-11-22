import type { DbExecutor } from "../../lib/db/db-executor";
import type { AuthSessionEntity } from "../domain/auth-session-entity";

export type AuthSessionRepo = {
  load(id: string, dbExecutor?: DbExecutor): Promise<AuthSessionEntity | null>;
  loadByToken(
    token: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthSessionEntity | null>;
  save(
    session: AuthSessionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AuthSessionEntity>;
};
