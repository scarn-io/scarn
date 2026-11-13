import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { resolveWorkerInstance } from "@scarn/worker";
import { CliError } from "../../lib/cli-error";
import { withReporter } from "../../lib/command-output";
import {
  createCliLogger,
  createTransport,
  ensureLogDir,
  resolveLogFilePath,
} from "../../lib/logger";
import { createReporter } from "../../lib/reporter";
import { ensureWorkerRunning } from "./background-start";
import { runForegroundWorker } from "./foreground-host";
import { assertPositiveInteger } from "./instance-settings";
import { runWorkerOnce, type RunOnceDeps } from "./run-once";

/** Seams for tests; production uses the defaults of each mode. */
export type WorkerStartDeps = {
  once?: Partial<Omit<RunOnceDeps, "reporter" | "logger" | "dest">> | undefined;
};

export type WorkerStartArguments = {
  project: string | undefined;
  foreground: boolean;
  maxConcurrency: number | undefined;
  baseUrl: string | undefined;
  once: boolean;
  concurrency: number | undefined;
  preserveRuntimeOnComplete: boolean;
  workItemId: string | undefined;
  sourceBranch: string | undefined;
};

const ONCE_ONLY_FLAGS: ReadonlyArray<[keyof WorkerStartArguments, string]> = [
  ["project", "<project>"],
  ["concurrency", "--concurrency"],
  ["workItemId", "--work-item-id"],
  ["sourceBranch", "--source-branch"],
];

function assertValidCombination(arguments_: WorkerStartArguments): void {
  if (arguments_.once && !arguments_.foreground) {
    throw new CliError("invalid_usage", "--once requires --foreground.");
  }
  if (arguments_.once) {
    if (arguments_.maxConcurrency !== undefined) {
      throw new CliError(
        "invalid_usage",
        "--max-concurrency applies to the background worker; use --concurrency with --once.",
      );
    }
    return;
  }
  for (const [key, flag] of ONCE_ONLY_FLAGS) {
    if (arguments_[key] !== undefined) {
      throw new CliError("invalid_usage", `${flag} requires --once.`);
    }
  }
  if (arguments_.preserveRuntimeOnComplete) {
    throw new CliError(
      "invalid_usage",
      "--preserve-runtime-on-complete requires --once.",
    );
  }
}

async function startInBackground(
  arguments_: WorkerStartArguments,
  instance: string,
): Promise<void> {
  assertPositiveInteger(arguments_.maxConcurrency, "--max-concurrency");
  await withReporter("worker-start-command", async ({ reporter }) => {
    const { started, worker, logFilePath } = await ensureWorkerRunning({
      instance,
      baseUrl: arguments_.baseUrl,
      maxConcurrency: arguments_.maxConcurrency,
    });
    const { pid, port } = worker.discovery;
    if (!started) {
      reporter.info(
        `Worker instance ${instance} is already running (pid ${String(pid)}).`,
      );
    }
    process.stdout.write(
      [
        `instance: ${instance}`,
        `pid: ${String(pid)}`,
        `port: ${String(port)}`,
        `log: ${logFilePath}`,
        "",
      ].join("\n"),
    );
    if (started) reporter.success(`Worker instance ${instance} started.`);
  });
}

async function startInForeground(
  arguments_: WorkerStartArguments,
  instance: string,
): Promise<void> {
  await withReporter("worker-host-command", ({ reporter }) =>
    runForegroundWorker(
      {
        instance,
        baseUrl: arguments_.baseUrl,
        maxConcurrency: arguments_.maxConcurrency,
      },
      {
        print: (line) => {
          reporter.info(line);
        },
      },
    ),
  );
}

async function runOnce(
  arguments_: WorkerStartArguments,
  instance: string,
  deps: WorkerStartDeps,
): Promise<void> {
  await ensureLogDir();
  const logFilePath = resolveLogFilePath();
  const dest = createTransport();
  const logger = createCliLogger("worker-start-once-command");
  const reporter = createReporter({ logFilePath });
  reporter.start("Scarn worker (once)");
  try {
    await runWorkerOnce(
      {
        instance,
        project: arguments_.project,
        baseUrl: arguments_.baseUrl,
        concurrency: arguments_.concurrency,
        preserveRuntimeOnComplete: arguments_.preserveRuntimeOnComplete,
        workItemId: arguments_.workItemId,
        sourceBranch: arguments_.sourceBranch,
      },
      { ...deps.once, reporter, logger, dest },
    );
    reporter.finish("Done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    reporter.finish("Worker stopped with errors");
    logger.error({ err: error }, "Worker --once failed");
    throw error;
  }
}

export async function runWorkerStart(
  arguments_: WorkerStartArguments,
  deps: WorkerStartDeps = {},
): Promise<void> {
  assertValidCombination(arguments_);
  const instance = resolveWorkerInstance();
  if (arguments_.once) {
    await runOnce(arguments_, instance, deps);
  } else if (arguments_.foreground) {
    await startInForeground(arguments_, instance);
  } else {
    await startInBackground(arguments_, instance);
  }
}

export function createWorkerStartCommand(
  deps: WorkerStartDeps = {},
): CommandModule<object, WorkerStartArguments> {
  return {
    command: "start [project]",
    describe:
      "Start this machine's background worker, or run it in the foreground",
    builder: (argv: Argv<object>) =>
      argv
        .positional("project", {
          describe:
            'With --once: the project to work on, as owner/slug (defaults to "project" in .scarn/scarn.jsonc)',
          type: "string",
        })
        .option("foreground", {
          describe:
            "Run the worker in this process instead of in the background",
          type: "boolean",
          default: false,
        })
        .option("maxConcurrency", {
          alias: "max-concurrency",
          describe:
            "Machine-wide limit on concurrent runs (saved for the instance)",
          type: "number",
        })
        .option("baseUrl", {
          alias: "base-url",
          describe:
            "Scarn app base URL; bound to the instance on its first start",
          type: "string",
        })
        .option("once", {
          describe:
            "With --foreground: poll one project a single time from the current checkout and wait for its runs",
          type: "boolean",
          default: false,
        })
        .option("concurrency", {
          alias: "c",
          describe: "With --once: maximum number of concurrently active jobs",
          type: "number",
        })
        .option("preserveRuntimeOnComplete", {
          alias: ["k", "preserve-runtime-on-complete"],
          describe:
            "With --once: keep runtime containers and workspace after task completion",
          type: "boolean",
          default: false,
        })
        .option("workItemId", {
          alias: "work-item-id",
          describe: "With --once: only process tasks for this work item ID",
          type: "string",
        })
        .option("sourceBranch", {
          alias: "source-branch",
          describe:
            "With --once: override the branch checked out for the first step of a run",
          type: "string",
        }),
    handler: (arguments_: ArgumentsCamelCase<WorkerStartArguments>) =>
      runWorkerStart(arguments_, deps),
  };
}

export const workerStartCommand = createWorkerStartCommand();
