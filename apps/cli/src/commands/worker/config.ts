/**
 * `scarn worker config [--max-concurrency <n>]`: without flags, prints the
 * instance's saved settings straight from disk, so it works whether or not
 * the worker is running. With `--max-concurrency`, changes the running
 * worker's machine-wide limit over `PATCH /config`; the worker saves it for
 * the instance, so it also applies after a restart.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  SqliteWorkerSettingsStore,
  resolveWorkerInstance,
  type WorkerSettingsStore,
} from "@scarn/worker";
import { withReporter } from "../../lib/command-output";
import {
  controlData,
  requireRunningWorker,
  type ConnectToWorkerDeps,
} from "./connect";
import {
  assertPositiveInteger,
  defaultMaxConcurrency,
} from "./instance-settings";

export type WorkerConfigArguments = {
  maxConcurrency: number | undefined;
};

export type WorkerConfigDeps = ConnectToWorkerDeps & {
  openStore?: (() => WorkerSettingsStore) | undefined;
  env?: Record<string, string | undefined> | undefined;
};

export async function runWorkerConfig(
  arguments_: WorkerConfigArguments,
  deps: WorkerConfigDeps = {},
): Promise<void> {
  const { maxConcurrency } = arguments_;
  if (maxConcurrency === undefined) {
    showWorkerConfig(deps);
    return;
  }
  assertPositiveInteger(maxConcurrency, "--max-concurrency");
  await withReporter("worker-config-command", async ({ reporter }) => {
    const instance = resolveWorkerInstance();
    const worker = await requireRunningWorker(
      instance,
      { checkVersion: true },
      deps,
    );
    const updated = await controlData(
      "change the worker's config",
      worker.client.config.patch({ maxConcurrency }),
    );
    process.stdout.write(
      `max-concurrency: ${String(updated.maxConcurrency)}\n`,
    );
    reporter.success(
      `Worker instance ${instance} now runs at most ${String(updated.maxConcurrency)} at a time.`,
    );
  });
}

/**
 * Prints the instance's saved settings. An instance that has never started
 * has none, so it shows the limit its first start would use.
 */
function showWorkerConfig(deps: WorkerConfigDeps): void {
  const instance = resolveWorkerInstance();
  const store = (deps.openStore ?? (() => new SqliteWorkerSettingsStore()))();
  const saved = readInstance(store, instance);
  const lines = saved
    ? [
        `instance: ${instance}`,
        `base-url: ${saved.baseUrl}`,
        `max-concurrency: ${String(saved.maxConcurrency)}`,
      ]
    : [
        `instance: ${instance}`,
        "base-url: (not bound)",
        `max-concurrency: ${String(defaultMaxConcurrency(deps.env))} (default)`,
      ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function readInstance(store: WorkerSettingsStore, instance: string) {
  try {
    return store.getInstance(instance);
  } finally {
    store.close();
  }
}

export function createWorkerConfigCommand(
  deps: WorkerConfigDeps = {},
): CommandModule<object, WorkerConfigArguments> {
  return {
    command: "config",
    describe:
      "Show this machine's background worker settings, or change them with a flag",
    builder: (argv: Argv<object>) =>
      argv.option("maxConcurrency", {
        alias: "max-concurrency",
        describe:
          "Machine-wide limit on concurrent runs (saved for the instance)",
        type: "number",
      }),
    handler: (arguments_: ArgumentsCamelCase<WorkerConfigArguments>) =>
      runWorkerConfig(arguments_, deps),
  };
}

export const workerConfigCommand = createWorkerConfigCommand();
