/**
 * The one Postgres database every workspace's integration tests share: a
 * single `scarn_test` database on a single reused testcontainers Postgres,
 * with every package's migrations (core, identity, growth) applied.
 *
 * `getTestDatabaseUrl()` is lazy and safe to call from any number of
 * processes at once (`bun test --parallel` workers, isolated test files,
 * concurrently running workspaces):
 *
 * - Fast path: a cache file in the OS temp dir remembers the last URL. If
 *   that database answers with the current migration fingerprint, it is
 *   returned after one query, without touching Docker.
 * - Slow path: under a lock file (so concurrent cold starts make exactly one
 *   container), start or attach to the reused container, then, under a
 *   Postgres advisory lock, create the database if needed and apply any
 *   migration files it hasn't seen. An applied file whose contents changed
 *   (an edited migration) makes it drop and rebuild the database.
 *
 * The container is started with `.withReuse()`, which testcontainers' Ryuk
 * reaper never removes, so it keeps running across separate local test
 * invocations. Never call `.stop()` on it: a sibling test process may be
 * using it. On CI the runner is torn down per job.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { Wait } from "testcontainers";

/**
 * Hook timeout for any `beforeAll` (or preload) that awaits
 * `getTestDatabaseUrl()`. A cold start pays for the container, `CREATE
 * DATABASE` and every migration while sibling workspaces contend for the
 * same Postgres, which can exceed bun's 5s default on CI.
 */
export const TEST_DB_SETUP_TIMEOUT_MS = 30_000;

const DATABASE_NAME = "scarn_test";

const POSTGRES_IMAGE =
  process.env["TEST_PGVECTOR_IMAGE"] ?? "pgvector/pgvector:pg17";

/**
 * Every `bun test --parallel` worker in every concurrently running workspace
 * opens its own connection pools (up to 10 each in core and identity), so
 * Postgres's default of 100 runs out on a many-core machine.
 */
const MAX_CONNECTIONS = 500;

const repoRoot = path.resolve(import.meta.dir, "../../../..");

/**
 * Applied in this order, matching `scripts/db-migrate.ts`. Sets whose package
 * is absent (the private `growth` package in the public mirror) are skipped.
 */
const MIGRATION_SETS = [
  { name: "core", dir: path.join(repoRoot, "packages/core/drizzle") },
  { name: "identity", dir: path.join(repoRoot, "packages/identity/drizzle") },
  { name: "growth", dir: path.join(repoRoot, "packages/growth/drizzle") },
].filter((set) => existsSync(set.dir));

type MigrationFile = { id: string; hash: string; sql: string };

const readMigrationFiles = (): MigrationFile[] =>
  MIGRATION_SETS.flatMap((set) =>
    readdirSync(set.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((folder) => {
        const sql = readFileSync(
          path.join(set.dir, folder, "migration.sql"),
          "utf8",
        );
        return {
          id: `${set.name}/${folder}`,
          hash: createHash("sha256").update(sql).digest("hex"),
          sql,
        };
      }),
  );

const fingerprintOf = (files: MigrationFile[]): string =>
  createHash("sha256")
    .update(files.map((file) => `${file.id}:${file.hash}`).join("\n"))
    .digest("hex");

const cacheFilePath = path.join(
  os.tmpdir(),
  `scarn-test-db-${createHash("sha256").update(`${POSTGRES_IMAGE}:${repoRoot}`).digest("hex").slice(0, 12)}.json`,
);

const readCachedUrl = async (): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(cacheFilePath, "utf8")) as {
      url?: unknown;
    };
    return typeof parsed.url === "string" ? parsed.url : undefined;
  } catch {
    return undefined;
  }
};

const writeCachedUrl = async (url: string): Promise<void> => {
  const tempPath = `${cacheFilePath}.${String(process.pid)}.tmp`;
  await writeFile(tempPath, JSON.stringify({ url }));
  await rename(tempPath, cacheFilePath);
};

const STATE_TABLE = `public."__test_db_state"`;
const APPLIED_TABLE = `public."__test_db_migrations"`;

/**
 * Opens one connection. Errors on an idle client are swallowed: a dropped
 * connection surfaces on the next query, and an unhandled `error` event
 * would otherwise crash the test process.
 */
const connect = async (
  url: string,
  options: { connectionTimeoutMillis?: number } = {},
): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: url, ...options });
  client.on("error", () => {});
  await client.connect();
  return client;
};

const isUpToDate = async (url: string, fingerprint: string) => {
  let client: pg.Client | undefined;
  try {
    client = await connect(url, { connectionTimeoutMillis: 2_000 });
    const { rows } = await client.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ${STATE_TABLE}`,
    );
    return rows[0]?.fingerprint === fingerprint;
  } catch {
    return false;
  } finally {
    await client?.end().catch(() => {});
  }
};

const assertDockerAvailable = () => {
  const dockerCheck = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (dockerCheck.error || dockerCheck.status !== 0) {
    const details =
      dockerCheck.error?.message ||
      dockerCheck.stderr ||
      "Docker daemon is unavailable.";
    throw new Error(
      `Docker is required for integration tests. ${details.trim()}`,
    );
  }
};

const startContainer = () =>
  new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("postgres")
    .withUsername("postgres")
    .withPassword("postgres")
    .withCommand([
      "postgres",
      "-c",
      `max_connections=${String(MAX_CONNECTIONS)}`,
    ])
    .withReuse()
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();

const databaseUrl = (
  container: Awaited<ReturnType<typeof startContainer>>,
  databaseName: string,
): string => {
  const url = new URL("postgres://localhost");
  url.hostname = container.getHost();
  url.port = String(container.getPort());
  url.username = container.getUsername();
  url.password = container.getPassword();
  url.pathname = `/${databaseName}`;
  return url.toString();
};

/**
 * Applies every migration file the database hasn't recorded yet. Returns
 * "rebuild" when the database must be dropped and recreated: an applied file
 * changed, or a new file failed on top of earlier ones (e.g. a half-applied
 * file from an interrupted run).
 */
const applyPendingMigrations = async (
  url: string,
  files: MigrationFile[],
): Promise<"ok" | "rebuild"> => {
  const client = await connect(url);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${APPLIED_TABLE} (id text PRIMARY KEY, hash text NOT NULL)`,
    );
    const applied = new Map(
      (
        await client.query<{ id: string; hash: string }>(
          `SELECT id, hash FROM ${APPLIED_TABLE}`,
        )
      ).rows.map((row) => [row.id, row.hash]),
    );
    const current = new Map(files.map((file) => [file.id, file.hash]));
    const drifted = [...applied].some(([id, hash]) => current.get(id) !== hash);
    if (drifted) return "rebuild";

    // Statements run one by one, outside a transaction: several migrations
    // `ALTER TYPE ... ADD VALUE` and then use the new value, which Postgres
    // rejects inside a single transaction. A file interrupted part-way is
    // never recorded, so the next attempt fails on it and rebuilds.
    for (const file of files) {
      if (applied.has(file.id)) continue;
      try {
        for (const statement of file.sql.split("--> statement-breakpoint")) {
          if (statement.trim()) await client.query(statement);
        }
      } catch (error) {
        if (applied.size === 0) throw error;
        console.warn(`[test-db] ${file.id} failed to apply: ${String(error)}`);
        return "rebuild";
      }
      await client.query(
        `INSERT INTO ${APPLIED_TABLE} (id, hash) VALUES ($1, $2)`,
        [file.id, file.hash],
      );
    }
    return "ok";
  } finally {
    await client.end();
  }
};

const writeFingerprint = async (url: string, fingerprint: string) => {
  const client = await connect(url);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (fingerprint text NOT NULL)`,
    );
    await client.query("BEGIN");
    try {
      await client.query(`DELETE FROM ${STATE_TABLE}`);
      await client.query(
        `INSERT INTO ${STATE_TABLE} (fingerprint) VALUES ($1)`,
        [fingerprint],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
};

const setUpDatabase = async (
  files: MigrationFile[],
  fingerprint: string,
): Promise<string> => {
  assertDockerAvailable();
  const container = await startContainer();
  const adminUrl = databaseUrl(container, "postgres");
  const targetUrl = databaseUrl(container, DATABASE_NAME);
  const admin = await connect(adminUrl);
  try {
    await admin.query("SELECT pg_advisory_lock(hashtext($1))", [
      `scarn-test-db:${DATABASE_NAME}`,
    ]);
    if (await isUpToDate(targetUrl, fingerprint)) return targetUrl;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const exists = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [DATABASE_NAME],
      );
      if (exists.rowCount === 0) {
        await admin.query(`CREATE DATABASE "${DATABASE_NAME}"`);
      }
      if ((await applyPendingMigrations(targetUrl, files)) === "ok") {
        await writeFingerprint(targetUrl, fingerprint);
        return targetUrl;
      }
      console.warn(
        `[test-db] an applied migration changed; rebuilding ${DATABASE_NAME}`,
      );
      await admin.query(`DROP DATABASE "${DATABASE_NAME}" WITH (FORCE)`);
    }
    throw new Error(`[test-db] could not migrate ${DATABASE_NAME}`);
  } finally {
    await admin.end();
  }
};

const LOCK_STALE_MS = 5 * 60_000;

/**
 * Cross-process mutex on a lock file next to the cache file. testcontainers'
 * `.withReuse()` only attaches to a container that already exists, so
 * processes cold-starting at the same moment would each create their own;
 * holding this while starting the container keeps it to exactly one. A lock
 * left by a crashed process is broken once it is `LOCK_STALE_MS` old.
 */
const withSetupLock = async <T>(run: () => Promise<T>): Promise<T> => {
  const lockPath = `${cacheFilePath}.lock`;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      break;
    } catch {
      const age = await stat(lockPath).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) await rm(lockPath, { force: true });
      await Bun.sleep(100);
    }
  }
  try {
    return await run();
  } finally {
    await rm(lockPath, { force: true });
  }
};

const resolveTestDatabaseUrl = async (): Promise<string> => {
  const files = readMigrationFiles();
  const fingerprint = fingerprintOf(files);

  const cachedUrl = await readCachedUrl();
  if (cachedUrl && (await isUpToDate(cachedUrl, fingerprint))) {
    return cachedUrl;
  }

  return withSetupLock(async () => {
    const urlFromWinner = await readCachedUrl();
    if (urlFromWinner && (await isUpToDate(urlFromWinner, fingerprint))) {
      return urlFromWinner;
    }
    const url = await setUpDatabase(files, fingerprint);
    await writeCachedUrl(url);
    return url;
  });
};

let urlPromise: Promise<string> | undefined;

/** Lazily ensures the shared, fully migrated test database; returns its URL. */
export const getTestDatabaseUrl = (): Promise<string> => {
  if (!urlPromise) {
    urlPromise = resolveTestDatabaseUrl();
    urlPromise.catch(() => {
      urlPromise = undefined;
    });
  }
  return urlPromise;
};
