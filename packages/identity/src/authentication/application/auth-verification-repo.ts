import type { DbExecutor } from "../../lib/db/db-executor";
import type { AuthVerificationEntity } from "../domain/auth-verification-entity";

export type AuthVerificationRepo = {
  load(
    id: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthVerificationEntity | null>;
  loadLatestByIdentifier(
    identifier: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthVerificationEntity | null>;
  save(
    verification: AuthVerificationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AuthVerificationEntity>;
};
