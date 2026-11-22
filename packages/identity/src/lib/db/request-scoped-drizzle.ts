import { AsyncLocalStorage } from "node:async_hooks";
import type { AnyRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

/**
 * One Drizzle client, built once, whose queries go to whichever node-postgres
 * pool the current `run` scope holds.
 *
 * Cloudflare Workers open a pool per request, and building a Drizzle client
 * per request re-derives the relational config of the whole schema every
 * time. Here Drizzle is built over a stand-in exposing only what
 * drizzle-orm/node-postgres uses: `query`, and `connect` for transactions.
 * Drizzle treats any client whose class name contains "Pool" as a pool and
 * checks out one connection per transaction, so the stand-in is named
 * accordingly. Type parsers travel with each query config, so nothing needs
 * copying onto the scoped pool.
 *
 * The pool is resolved when a query executes, not when it is built: a query
 * must be awaited inside `run`, or it throws.
 */
export const createRequestScopedDrizzle = <TRelations extends AnyRelations>(
  relations: TRelations,
) => {
  const scope = new AsyncLocalStorage<pg.Pool>();

  const currentPool = (): pg.Pool => {
    const pool = scope.getStore();
    if (!pool) {
      throw new Error("No request-scoped SQL client is active");
    }
    return pool;
  };

  class RequestScopedPool {
    query(...args: Parameters<pg.Pool["query"]>) {
      return (currentPool().query as (...a: unknown[]) => unknown)(...args);
    }
    connect() {
      return currentPool().connect();
    }
  }

  const db = drizzle({
    client: new RequestScopedPool() as unknown as pg.Pool,
    relations,
  });

  return {
    db,
    current: (): pg.Pool | undefined => scope.getStore(),
    run: <T>(pool: pg.Pool, fn: () => T): T => scope.run(pool, fn),
  };
};
