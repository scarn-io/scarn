/**
 * Seed deletes work items and runs, so it only runs against a local stack:
 * `DATABASE_URL` (loaded from the repo-root `.env` via `bun --env-file`) must
 * point at localhost, and `BASE_URL` must be a localhost origin.
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export function assertLocalEnvironment(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "[local-dev] refusing to run: DATABASE_URL is not set. " +
        "Run through `bun run --filter @scarn/local-dev <script>`, which loads the repo-root .env.",
    );
  }

  const databaseHost = hostnameOf(databaseUrl);
  if (!databaseHost || !LOCAL_HOSTNAMES.has(databaseHost)) {
    throw new Error(
      `[local-dev] refusing to run: DATABASE_URL host is ${databaseHost ?? "unparseable"}, not localhost/127.0.0.1.`,
    );
  }

  const baseHost = hostnameOf(baseUrl);
  if (!baseHost || !LOCAL_HOSTNAMES.has(baseHost)) {
    throw new Error(
      `[local-dev] refusing to run: BASE_URL ${baseUrl} is not a localhost origin.`,
    );
  }
}
