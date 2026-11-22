import { afterAll, beforeAll } from "bun:test";
import pg from "pg";

const DEMO_PROJECT_TEST_LOCK_KEY = 872_341_002;

/**
 * Serializes test files that refresh the singleton demo project across
 * `bun test --parallel` workers. `refreshDemoProject` short-circuits when
 * another refresh holds its advisory lock, so two files refreshing at once
 * would see each other's refresh as a no-op (or tasks changing underneath
 * them). Call at the top level of a test file: it holds a blocking,
 * session-scoped advisory lock on a dedicated connection from `beforeAll`
 * until `afterAll`.
 */
export const holdDemoProjectTestLock = (): void => {
  let lockHolder: pg.Client | undefined;

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error("Expected DATABASE_URL to be set by the test db setup");
    }
    lockHolder = new pg.Client({ connectionString: databaseUrl });
    await lockHolder.connect();
    await lockHolder.query("select pg_advisory_lock($1)", [
      DEMO_PROJECT_TEST_LOCK_KEY,
    ]);
  }, 120_000);

  afterAll(async () => {
    await lockHolder?.end();
    lockHolder = undefined;
  });
};
