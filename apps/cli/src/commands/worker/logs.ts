/**
 * `scarn worker logs [project] [--run id] [-f]`: reads the instance's worker
 * log (`worker.log`) straight from disk, so it works whether or not the
 * worker is running, and skips the version check. Lines are pretty-printed
 * in a terminal and printed as the raw JSON lines when output is piped.
 *
 * `[project]` is a project ID, or the ref (`owner/slug`) of a project saved
 * for the instance; refs are resolved from the instance's saved projects so
 * no sign-in or network is needed.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { prettyFactory } from "pino-pretty";
import {
  DEFAULT_LOG_TAIL,
  SqliteWorkerSettingsStore,
  followWorkerLog,
  readWorkerLog,
  resolveWorkerInstance,
  workerLogFilePath,
  type WorkerSettingsStore,
} from "@scarn/worker";
import { CliError } from "../../lib/cli-error";
import { subscribeProcessStopSignals } from "./stop-signals";

const UUID_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export type WorkerLogsArguments = {
  project: string | undefined;
  run: string | undefined;
  follow: boolean;
  tail: number;
};

export type WorkerLogsDeps = {
  openStore?: (() => WorkerSettingsStore) | undefined;
  write?: ((text: string) => void) | undefined;
  isTTY?: boolean | undefined;
  pollMs?: number | undefined;
  /** Calls `onInterrupt` on Ctrl-C while following; returns the unsubscribe. */
  subscribeInterrupt?: ((onInterrupt: () => void) => () => void) | undefined;
};

/**
 * The project ID for `[project]`: an ID is taken as is; a ref must name a
 * project saved for the instance.
 */
export function resolveLogProjectId(
  project: string,
  instance: string,
  openStore: () => WorkerSettingsStore,
): string {
  if (UUID_PATTERN.test(project)) return project;
  const store = openStore();
  try {
    const saved = store
      .listProjects(instance)
      .find((p) => p.projectRef === project || p.projectId === project);
    if (saved) return saved.projectId;
  } finally {
    store.close();
  }
  throw new CliError(
    "project_not_found",
    `Worker instance ${instance} has no project ${project}. Pass a project ID or the ref of a project added to the worker.`,
  );
}

export async function runWorkerLogs(
  arguments_: WorkerLogsArguments,
  deps: WorkerLogsDeps = {},
): Promise<void> {
  if (!Number.isInteger(arguments_.tail) || arguments_.tail < 0) {
    throw new CliError(
      "invalid_usage",
      "--tail must be a non-negative integer.",
    );
  }
  const instance = resolveWorkerInstance();
  const openStore = deps.openStore ?? (() => new SqliteWorkerSettingsStore());
  const filter = {
    projectId:
      arguments_.project === undefined
        ? undefined
        : resolveLogProjectId(arguments_.project, instance, openStore),
    taskRunId: arguments_.run,
  };
  const filePath = workerLogFilePath(instance);
  const write =
    deps.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const format = lineFormatter(deps.isTTY ?? process.stdout.isTTY);
  const { lines, offset } = await readWorkerLog({
    ...filter,
    filePath,
    tail: arguments_.tail,
  });
  for (const line of lines) write(format(line));
  if (!arguments_.follow) return;

  const stop = new AbortController();
  const unsubscribe = (
    deps.subscribeInterrupt ??
    ((onInterrupt) => subscribeProcessStopSignals(onInterrupt))
  )(() => {
    stop.abort();
  });
  try {
    for await (const line of followWorkerLog({
      ...filter,
      filePath,
      from: offset,
      signal: stop.signal,
      pollMs: deps.pollMs,
    })) {
      write(format(line));
    }
  } finally {
    unsubscribe();
  }
}

function lineFormatter(pretty: boolean): (line: string) => string {
  if (!pretty) return (line) => `${line}\n`;
  const prettify = prettyFactory({
    colorize: true,
    translateTime: "SYS:standard",
    ignore: "pid,hostname",
  });
  return (line) => {
    try {
      return prettify(JSON.parse(line));
    } catch {
      return `${line}\n`;
    }
  };
}

export function createWorkerLogsCommand(
  deps: WorkerLogsDeps = {},
): CommandModule<object, WorkerLogsArguments> {
  return {
    command: "logs [project]",
    describe:
      "Show this machine's background worker log, even when it is not running",
    builder: (argv: Argv<object>) =>
      argv
        .positional("project", {
          describe:
            "Only lines for this project: its ID, or the owner/slug of a project added to the worker",
          type: "string",
        })
        .option("run", {
          describe: "Only lines for this Task run ID",
          type: "string",
        })
        .option("follow", {
          alias: "f",
          describe: "Keep printing lines as they are written",
          type: "boolean",
          default: false,
        })
        .option("tail", {
          describe: "How many of the last matching lines to show first",
          type: "number",
          default: DEFAULT_LOG_TAIL,
        }),
    handler: (arguments_: ArgumentsCamelCase<WorkerLogsArguments>) =>
      runWorkerLogs(arguments_, deps),
  };
}

export const workerLogsCommand = createWorkerLogsCommand();
