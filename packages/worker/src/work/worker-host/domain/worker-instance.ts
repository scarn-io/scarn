/**
 * Worker instance naming. One background worker runs per machine and CLI
 * instance, so a `scarn` install and a `scarn-dev` link keep separate
 * workers, logs, and saved settings. The name is resolved from
 * `SCARN_WORKER_INSTANCE`, then `SCARN_CLI_NAME` (set by the `bin/scarn`
 * wrapper to the name it was invoked as), then `"scarn"`.
 */

export const DEFAULT_WORKER_INSTANCE = "scarn";

const INSTANCE_NAME_PATTERN = /^[a-z0-9-]+$/u;
const LAUNCHER_EXTENSION_PATTERN = /\.(?:exe|cmd|bat|ps1|js|cjs|mjs)$/iu;

export class InvalidWorkerInstanceError extends Error {
  readonly instance: string;
  readonly source: "SCARN_WORKER_INSTANCE" | "SCARN_CLI_NAME";

  constructor(
    instance: string,
    source: "SCARN_WORKER_INSTANCE" | "SCARN_CLI_NAME",
  ) {
    super(
      `Invalid worker instance name "${instance}" (from ${source}). ` +
        "Use only lowercase letters, digits, and dashes.",
    );
    this.name = "InvalidWorkerInstanceError";
    this.instance = instance;
    this.source = source;
  }
}

export function isValidWorkerInstanceName(name: string): boolean {
  return INSTANCE_NAME_PATTERN.test(name);
}

export function resolveWorkerInstance(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env["SCARN_WORKER_INSTANCE"]?.trim();
  if (explicit) {
    return assertValid(explicit, "SCARN_WORKER_INSTANCE");
  }

  const cliName = env["SCARN_CLI_NAME"]
    ?.trim()
    .replace(LAUNCHER_EXTENSION_PATTERN, "");
  if (cliName) {
    return assertValid(cliName, "SCARN_CLI_NAME");
  }

  return DEFAULT_WORKER_INSTANCE;
}

function assertValid(
  name: string,
  source: "SCARN_WORKER_INSTANCE" | "SCARN_CLI_NAME",
): string {
  if (!isValidWorkerInstanceName(name)) {
    throw new InvalidWorkerInstanceError(name, source);
  }
  return name;
}
