import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createRequestScopedDrizzle } from "@scarn/identity/request-scoped-drizzle";
import { ConfigurationError } from "../errors";
import { relations } from "./relations";

type Db = ReturnType<typeof drizzle<typeof relations>>;

let sqlClient: pg.Pool | undefined;
let dbClient: Db | undefined;

const requestDb = createRequestScopedDrizzle(relations);

const getSharedDb = (): Db => {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new ConfigurationError(
      "DATABASE_URL is not set",
      "DATABASE_URL_NOT_SET",
    );
  }

  if (!sqlClient) {
    sqlClient = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  if (!dbClient) {
    dbClient = drizzle({ client: sqlClient, relations });
  }

  return dbClient;
};

/**
 * The Drizzle client for the current request scope (see `runWithSqlClient`),
 * or else the process-wide client built from `DATABASE_URL`.
 */
export const getDb = (): Db =>
  requestDb.current() ? requestDb.db : getSharedDb();

/**
 * Runs `fn` with `getDb()` bound to `pool`. Cloudflare Workers cannot share a
 * connection across requests, so the Worker entry opens one pool per request
 * and ends it itself; the Node/Bun entries never call this.
 */
export const runWithSqlClient = <T>(pool: pg.Pool, fn: () => T): T =>
  requestDb.run(pool, fn);

export const closeDb = async () => {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = undefined;
    dbClient = undefined;
  }
};
