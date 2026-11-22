import type { DbExecutor } from "../../lib/db/db-executor";
import type { AuthAccountEntity } from "../domain/auth-account-entity";

export type AuthAccountRepo = {
  load(id: string, dbExecutor?: DbExecutor): Promise<AuthAccountEntity | null>;
  loadByProviderAccount(
    providerId: string,
    accountId: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthAccountEntity | null>;
  loadByUserId(
    userId: string,
    dbExecutor?: DbExecutor,
  ): Promise<AuthAccountEntity[]>;
  save(
    account: AuthAccountEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AuthAccountEntity>;
};
