import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getDatabaseUrl } from "../env";
import { createRequestScopedDrizzle } from "./request-scoped-drizzle";
import { relations } from "./relations";

type Db = ReturnType<typeof drizzle<typeof relations>>;

let sqlClient: pg.Pool | undefined;
let dbClient: Db | undefined;

const requestDb = createRequestScopedDrizzle(relations);

const getSharedDb = (): Db => {
  if (!sqlClient) {
    sqlClient = new pg.Pool({
      connectionString: getDatabaseUrl(),
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

export const getSqlClient = () => {
  const scoped = requestDb.current();
  if (scoped) {
    return scoped;
  }

  const db = getSharedDb();
  void db;

  if (!sqlClient) {
    throw new Error("SQL client is not initialized");
  }

  return sqlClient;
};

/**
 * Runs `fn` with `getDb()` and `getSqlClient()` bound to `pool`. Cloudflare
 * Workers cannot share a connection across requests, so the Worker entry opens
 * one pool per request and ends it itself; the Node/Bun entries never call
 * this.
 */
export const runWithSqlClient = <T>(pool: pg.Pool, fn: () => T): T =>
  requestDb.run(pool, fn);

/**
 * A stand-in for `getDb()` that resolves the current client on every property
 * access, for consumers that keep the client they are given (Better Auth's
 * Drizzle adapter) and must still follow the request scope.
 */
export const currentDb: Db = new Proxy({} as Db, {
  get: (_target, property) => {
    const db = getDb();
    const value: unknown = Reflect.get(db, property, db);
    return typeof value === "function"
      ? (value as (...args: never[]) => unknown).bind(db)
      : value;
  },
  has: (_target, property) => Reflect.has(getDb(), property),
});

export const closeDb = async () => {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = undefined;
    dbClient = undefined;
  }
};

export const resetDbForTests = async () => {
  await closeDb();
};
