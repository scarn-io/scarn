/**
 * `scarn worker config --max-concurrency <n>`: changes the running worker's
 * machine-wide limit over `PATCH /config`. The worker saves it for the
 * instance, so it also applies after a restart.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { resolveWorkerInstance } from "@scarn/worker";
import { CliError } from "../../lib/cli-error";
import { withReporter } from "../../lib/command-output";
import {
  controlData,
  requireRunningWorker,
  type ConnectToWorkerDeps,
} from "./connect";
import { assertPositiveInteger } from "./instance-settings";

export type WorkerConfigArguments = {
  maxConcurrency: number | undefined;
};

export async function runWorkerConfig(
  arguments_: WorkerConfigArguments,
  deps: ConnectToWorkerDeps = {},
): Promise<void> {
  const { maxConcurrency } = arguments_;
  if (maxConcurrency === undefined) {
    throw new CliError(
      "invalid_usage",
      "Nothing to change: pass --max-concurrency <n>.",
    );
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

export function createWorkerConfigCommand(
  deps: ConnectToWorkerDeps = {},
): CommandModule<object, WorkerConfigArguments> {
  return {
    command: "config",
    describe: "Change the running background worker's settings",
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
