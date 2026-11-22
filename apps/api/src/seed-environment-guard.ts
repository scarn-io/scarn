/**
 * Refuses to run when `DATABASE_URL` and the configured object store
 * (`S3_BUCKET` / `S3_ENDPOINT`) point at inconsistent environments.
 *
 * Bun's `--env-file` only fills in vars that aren't already set in the shell
 * (standard dotenv precedence: existing process env wins). So exporting, say,
 * a production `DATABASE_URL` before running
 * `bun --env-file=../../.env run src/seed-demo-project.ts --reset` silently
 * leaves every `S3_*` var on the repo's local-RustFS defaults. The seed script
 * then writes real rows (executions, archived-log refs, artifact records)
 * against production Postgres while the actual log/artifact bytes land in
 * local RustFS — the deployed app's real S3 bucket never receives them, so
 * artifact downloads 404 (`NoSuchKey`) and archived-then-purged step logs
 * come back empty.
 *
 * There is no cross-check between DB and object-store env vars anywhere else
 * in the stack (see `packages/core/src/lib/di.ts` and
 * `packages/core/src/artifacts/infra/s3-object-store.ts` — each resolves its
 * own env vars independently), so this seed script — the one place a
 * developer runs ad hoc, pointed at whatever environment they choose — is
 * where the check needs to live.
 */
export function assertConsistentSeedEnvironment(
  env: Record<string, string | undefined> = process.env,
): void {
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) {
    // Let the DB layer's own ConfigurationError report a missing DATABASE_URL.
    return;
  }
  const isLocalDatabase = isLocalHost(databaseUrl);

  const s3Bucket = env["S3_BUCKET"];
  if (!s3Bucket) {
    // Object storage disabled entirely — nothing to write to the wrong place.
    return;
  }
  // Per infra/README.md ("Application runtime credentials"): S3_ENDPOINT is
  // set ONLY for local RustFS/LocalStack; production targets real AWS S3 and
  // must never set it.
  const isLocalObjectStore = Boolean(env["S3_ENDPOINT"]);

  if (isLocalDatabase !== isLocalObjectStore) {
    const dbDescription = isLocalDatabase
      ? "local (DATABASE_URL host is localhost/127.0.0.1)"
      : "remote (DATABASE_URL host is not localhost)";
    const s3Description = isLocalObjectStore
      ? "local (S3_ENDPOINT is set)"
      : "remote AWS (S3_ENDPOINT is unset)";
    throw new Error(
      "[seed:demo-project] refusing to run: DATABASE_URL looks " +
        `${dbDescription}, but the configured object store looks ${s3Description}. ` +
        "This usually means only one of DATABASE_URL / S3_* was overridden in " +
        "your shell while the other fell through to the repo-root .env defaults " +
        "(bun --env-file only fills in vars that aren't already set in the " +
        "process environment). Writing artifacts/logs in this state creates DB " +
        "rows that reference S3 keys which don't exist in the bucket the real " +
        "app reads from.\n\n" +
        "Fix: source a consistent, full environment for the target you actually " +
        "mean to seed — e.g. `vercel env pull .env.production " +
        "--environment=production` and run with `--env-file=.env.production` — " +
        "or unset the vars you exported so the repo-root .env's local defaults " +
        "apply consistently.",
    );
  }
}

function isLocalHost(databaseUrl: string): boolean {
  try {
    const { hostname } = new URL(databaseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    // Unparseable DATABASE_URL — let the DB connection layer surface the
    // real error instead of guessing here.
    return false;
  }
}
