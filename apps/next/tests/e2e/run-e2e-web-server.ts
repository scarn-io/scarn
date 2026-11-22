import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { computeBuildInputHash } from "./build-input-hash";

const defaultE2eDatabaseUrl = new URL("postgres://127.0.0.1:6429/scarn_e2e");
defaultE2eDatabaseUrl.username = "postgres";
defaultE2eDatabaseUrl.password = "postgres";

const e2eDatabaseUrl =
  process.env["E2E_DATABASE_URL"] ?? defaultE2eDatabaseUrl.toString();
const e2eBaseUrl = process.env["E2E_BASE_URL"] ?? "http://localhost:3100";
const e2eAppUrl = process.env["E2E_APP_URL"] ?? e2eBaseUrl;
const e2ePort = process.env["E2E_PORT"] ?? "3100";
const shouldBuild = process.env["E2E_BUILD"] !== "false";
const isCi = Boolean(process.env["CI"]);

// Env shared by `next build` and `next start`. It must be identical across both
// because Next inlines NEXT_PUBLIC_* / `env` config values at BUILD time; a
// mismatch would bake wrong values into the bundle. Keeping VERCEL_ENV out of
// "production" ensures the build keeps the dev-login route (see next.config.ts).
// E2E_SKIP_TYPECHECK skips `next build`'s type check (see next.config.ts).
const nextServerEnv: Record<string, string> = {
  DATABASE_URL: e2eDatabaseUrl,
  NEXT_PUBLIC_SCARN_API_URL: e2eBaseUrl,
  SCARN_API_URL: e2eBaseUrl,
  APP_URL: e2eAppUrl,
  BETTER_AUTH_URL: e2eAppUrl,
  BETTER_AUTH_TRUSTED_ORIGINS: e2eAppUrl,
  BETTER_AUTH_SECRET:
    process.env["BETTER_AUTH_SECRET"] ?? "e2e-local-secret-not-for-production",
  ENABLE_DEV_LOGIN: "true",
  VERCEL_ENV: process.env["VERCEL_ENV"] ?? "development",
  E2E_SKIP_TYPECHECK: "1",
};

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(appRoot, "../..");
const nextLockFile = resolve(appRoot, ".next/dev/lock");
const nextBuildIdFile = resolve(appRoot, ".next/BUILD_ID");
const buildInputHashFile = resolve(appRoot, ".next/e2e-input-hash");
const databaseNamePattern = /^[A-Za-z0-9_]+$/u;

const childProcesses = new Set<Bun.Subprocess>();

const killChildProcesses = (): void => {
  for (const child of childProcesses) {
    child.kill();
  }
};

const getDatabaseName = (databaseUrl: string): string => {
  const pathname = new URL(databaseUrl).pathname.replace(/^\/+/u, "");
  if (!pathname) {
    throw new Error(
      `Invalid E2E_DATABASE_URL (missing database name): ${databaseUrl}`,
    );
  }
  if (!databaseNamePattern.test(pathname)) {
    throw new Error(
      `Invalid E2E_DATABASE_URL (unsupported database name): ${pathname}`,
    );
  }
  return pathname;
};

const getAdminDatabaseUrl = (databaseUrl: string): string => {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  return adminUrl.toString();
};

const runBunCommand = async (
  args: string[],
  envOverrides: Record<string, string>,
): Promise<void> => {
  const command = ["bun", ...args];
  console.log(`[e2e] running: ${command.join(" ")}`);
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    env: { ...process.env, ...envOverrides },
    stdout: "inherit",
    stderr: "inherit",
  });
  childProcesses.add(proc);
  const exitCode = await proc.exited;
  childProcesses.delete(proc);

  if (exitCode !== 0) {
    throw new Error(
      `[e2e] command failed (${String(exitCode)}): ${command.join(" ")}`,
    );
  }
};

const recreateDatabase = async (databaseUrl: string): Promise<void> => {
  const databaseName = getDatabaseName(databaseUrl);
  const escapedDatabaseName = databaseName.replaceAll('"', '""');
  const client = new pg.Client({
    connectionString: getAdminDatabaseUrl(databaseUrl),
  });
  await client.connect();

  try {
    await client.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    await client.query(`drop database if exists "${escapedDatabaseName}"`);
    await client.query(`create database "${escapedDatabaseName}"`);
    console.log(`[e2e] recreated database ${databaseName}`);
  } finally {
    await client.end();
  }
};

const setupDatabase = async (): Promise<void> => {
  await recreateDatabase(e2eDatabaseUrl);

  const env = {
    DATABASE_URL: e2eDatabaseUrl,
  };

  await runBunCommand(["db:migrate"], env);
};

const readStoredBuildInputHash = (): string | null =>
  existsSync(nextBuildIdFile) && existsSync(buildInputHashFile)
    ? readFileSync(buildInputHashFile, "utf8").trim()
    : null;

/**
 * Production build: routes are precompiled, so `next start` serves them
 * instantly. This avoids the dev server's on-demand per-route compilation,
 * which saturates under parallel e2e load and turns slow first requests into
 * whole-test timeouts. The build doesn't touch the database, so it runs
 * alongside `setupDatabase`.
 *
 * `E2E_BUILD=false` always reuses the existing build. Locally (not in CI) the
 * build is also skipped when the input hash stored next to `.next/BUILD_ID`
 * matches the current sources and build env.
 */
const buildNextApp = async (): Promise<void> => {
  if (!shouldBuild) {
    console.log("[e2e] E2E_BUILD=false, reusing the existing Next build");
    return;
  }

  const inputHash = isCi
    ? null
    : computeBuildInputHash({ repoRoot, appRoot, buildEnv: nextServerEnv });
  if (inputHash && readStoredBuildInputHash() === inputHash) {
    console.log("[e2e] Next build inputs unchanged, skipping next build");
    return;
  }

  rmSync(buildInputHashFile, { force: true });
  await runBunCommand(
    ["run", "--filter", "@scarn/next", "build"],
    nextServerEnv,
  );
  if (inputHash) {
    writeFileSync(buildInputHashFile, `${inputHash}\n`);
  }
};

const startNextServer = async (): Promise<number> => {
  const server = Bun.spawn(
    [
      "bun",
      "--elide-lines=0",
      "run",
      "--filter",
      "@scarn/next",
      "start",
      "--port",
      e2ePort,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...nextServerEnv,
      },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  childProcesses.add(server);

  return server.exited;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killChildProcesses();
    process.exit(1);
  });
}

rmSync(nextLockFile, { force: true });
try {
  await Promise.all([setupDatabase(), buildNextApp()]);
} catch (error) {
  killChildProcesses();
  throw error;
}
const exitCode = await startNextServer();
process.exit(exitCode);
