import { type getDb } from "./index";

export type DbClient = ReturnType<typeof getDb>;
export type DbTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export type DbExecutor = DbClient | DbTransaction;
