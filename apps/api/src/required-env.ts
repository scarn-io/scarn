/**
 * Startup check for the environment variables a standalone process cannot run
 * without. Lists every missing variable in one error so a self-hosted install
 * fails fast with a fixable message instead of on its first request.
 *
 * Only the standalone entry points (`index.ts`, `scheduler/run.ts`) call it;
 * the Cloudflare/Lambda shells and the Next.js in-process mount get their
 * configuration from their own deploy tooling.
 */

type Env = Record<string, string | undefined>;

export const API_REQUIRED_ENV = [
  "DATABASE_URL",
  "SECRETS_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "APP_URL",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

export const SCHEDULER_REQUIRED_ENV = ["RECONCILE_CRON_SECRET"] as const;

export class MissingEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], context: string) {
    super(
      `${context} is missing required environment variables: ${missing.join(", ")}. ` +
        "Set them in your environment (self-hosted: .env.selfhost, see .env.selfhost.example).",
    );
    this.name = "MissingEnvError";
    this.missing = missing;
  }
}

export const findMissingEnv = (
  required: readonly string[],
  env: Env = process.env,
): string[] => required.filter((key) => !env[key]?.trim());

/** Throws a {@link MissingEnvError} naming every unset or blank variable. */
export const assertRequiredEnv = (
  required: readonly string[],
  context: string,
  env: Env = process.env,
): void => {
  const missing = findMissingEnv(required, env);
  if (missing.length > 0) {
    throw new MissingEnvError(missing, context);
  }
};
