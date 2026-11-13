/**
 * The instance-wide settings `scarn worker start` saves: the base URL the
 * instance works for (bound on its first start) and the machine-wide limit.
 */
import {
  resolveScarnBaseUrl,
  type WorkerInstanceSettings,
  type WorkerSettingsStore,
} from "@scarn/worker";
import { CliError } from "../../lib/cli-error";

export const DEFAULT_MAX_CONCURRENCY = 1;

/**
 * The machine-wide limit for an instance with none saved:
 * `SCARN_WORK_CONCURRENCY` when it is a positive integer, else 1, the same
 * default a single `scarn work` loop uses.
 */
export function defaultMaxConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env["SCARN_WORK_CONCURRENCY"]);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_CONCURRENCY;
}

/** Raised when `--base-url` names another server than the instance's saved one. */
export class WorkerInstanceBaseUrlError extends CliError {
  constructor(
    readonly instance: string,
    readonly savedBaseUrl: string,
    readonly requestedBaseUrl: string,
  ) {
    super(
      "worker_base_url_mismatch",
      `Worker instance ${instance} works for ${savedBaseUrl}, not ${requestedBaseUrl}. ` +
        "Use the instance that works for that server, or start a separate one " +
        "with SCARN_WORKER_INSTANCE=<name>.",
    );
    this.name = "WorkerInstanceBaseUrlError";
  }
}

export function assertPositiveInteger(
  value: number | undefined,
  flag: string,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new CliError("invalid_usage", `${flag} must be a positive integer.`);
  }
}

/**
 * Saves the instance's settings for this start and returns them. The base
 * URL is `--base-url`, else the saved one, else `SCARN_BASE_URL` or the
 * default server; a `--base-url` that differs from the saved one is refused.
 * The limit is `--max-concurrency`, else the saved one, else
 * {@link defaultMaxConcurrency}.
 */
export function bindInstanceSettings(
  store: WorkerSettingsStore,
  input: {
    instance: string;
    baseUrl?: string | undefined;
    maxConcurrency?: number | undefined;
    env?: Record<string, string | undefined> | undefined;
  },
): WorkerInstanceSettings {
  assertPositiveInteger(input.maxConcurrency, "--max-concurrency");
  const saved = store.getInstance(input.instance);
  const requested =
    input.baseUrl === undefined
      ? undefined
      : resolveScarnBaseUrl(input.baseUrl);
  if (saved && requested !== undefined && requested !== saved.baseUrl) {
    throw new WorkerInstanceBaseUrlError(
      input.instance,
      saved.baseUrl,
      requested,
    );
  }
  return store.saveInstance({
    instance: input.instance,
    baseUrl: requested ?? saved?.baseUrl ?? resolveScarnBaseUrl(),
    maxConcurrency:
      input.maxConcurrency ??
      saved?.maxConcurrency ??
      defaultMaxConcurrency(input.env),
  });
}
