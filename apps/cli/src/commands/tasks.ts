import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  TASK_KINDS,
  TASK_STATUSES,
  formatTaskList,
  formatTaskView,
  gatherTaskList,
  gatherTaskView,
  type ProjectTaskStatus,
  type TaskKind,
} from "@scarn/shared-core";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import {
  withBaseUrlOption,
  withProjectOptions,
  type ProjectArguments,
} from "../lib/connect-project";
import {
  withOutputOptions,
  writeJson,
  writeText,
  type OutputArguments,
} from "../lib/output";
import {
  realTaskReadDependencies,
  type TaskReadDependencies,
} from "../lib/task-read-dependencies";
import {
  realTaskActionDependencies,
  withTaskActionCommands,
  type TaskActionDependencies,
} from "./tasks-actions";

/**
 * `scarn tasks list` and `scarn tasks view`: find Tasks and read one with
 * its runs and the earlier Tasks of its step. The action verbs live in
 * `./tasks-actions.ts`.
 */

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 200;

function listLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new CliError(
      "invalid_usage",
      `--limit must be a whole number from 1 to ${String(MAX_LIST_LIMIT)}, got ${String(limit)}.`,
    );
  }
  return limit;
}

function parseStatuses(statuses: string[] | undefined): ProjectTaskStatus[] {
  return (statuses ?? []).map((status) => {
    const known = TASK_STATUSES.find((candidate) => candidate === status);
    if (known === undefined) {
      throw new CliError(
        "invalid_usage",
        `Invalid --status "${status}". Expected one of: ${TASK_STATUSES.join(", ")}.`,
      );
    }
    return known;
  });
}

function parseKind(kind: string | undefined): TaskKind | undefined {
  if (kind === undefined) return undefined;
  const known = TASK_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new CliError(
      "invalid_usage",
      `Invalid --kind "${kind}". Expected one of: ${TASK_KINDS.join(", ")}.`,
    );
  }
  return known;
}

// list

interface ListArguments extends ProjectArguments, OutputArguments {
  workItem: string | undefined;
  status: string[] | undefined;
  kind: string | undefined;
}

const taskListCommand = (
  deps: TaskReadDependencies,
): CommandModule<object, ListArguments> => ({
  command: "list",
  describe: "List the project's Tasks, newest first",
  builder: (argv: Argv<object>) =>
    withOutputOptions(withProjectOptions(argv))
      .option("workItem", {
        alias: "work-item",
        type: "string",
        describe: "Only this work item's Tasks: its id, tracker URL, or key",
      })
      .option("status", {
        type: "string",
        array: true,
        describe: `Only Tasks with this status (repeat for several): ${TASK_STATUSES.join(", ")}`,
      })
      .option("kind", {
        type: "string",
        describe: TASK_KINDS.join(" or "),
      }),
  handler: (args: ArgumentsCamelCase<ListArguments>) =>
    withReporter("tasks-list", async () => {
      const limit = listLimit(args.limit);
      const statuses = parseStatuses(args.status);
      const kind = parseKind(args.kind);
      const { client, headers, projectId } = await deps.connectProject(args);
      const workItemId =
        args.workItem === undefined
          ? undefined
          : (await deps.resolveRef(args.workItem, args)).workItemId;
      const page = await gatherTaskList({
        client,
        headers,
        projectId,
        workItemId,
        statuses,
        kind,
        limit,
      });
      if (args.json) writeJson(page);
      else writeText(formatTaskList(page));
    }),
});

// view

interface ViewArguments {
  taskId: string;
  json: boolean;
  baseUrl: string | undefined;
}

const taskViewCommand = (
  deps: TaskReadDependencies,
): CommandModule<object, ViewArguments> => ({
  command: "view <taskId>",
  describe:
    "Show a Task: its instructions, input, config, runs and earlier Tasks",
  builder: (argv: Argv<object>) =>
    withBaseUrlOption(argv)
      .positional("taskId", {
        describe: "The Task ID",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe:
          "Print the Task, its runs and earlier Tasks as a single JSON document",
        type: "boolean",
        default: false,
      }),
  handler: (args: ArgumentsCamelCase<ViewArguments>) =>
    withReporter("tasks-view", async () => {
      const { client, headers } = await deps.connect(args);
      const gathered = await gatherTaskView({
        client,
        headers,
        taskId: args.taskId,
      });
      if (args.json) writeJson(gathered);
      else writeText(formatTaskView(gathered));
    }),
});

// parent

/** Builds `scarn tasks`; tests pass fake dependencies. */
export function createTasksCommand(
  deps: TaskReadDependencies = realTaskReadDependencies,
  actionDeps: TaskActionDependencies = realTaskActionDependencies,
): CommandModule<object, object> {
  return {
    command: "tasks <command>",
    describe: "List Tasks, read one with its runs, and retry or cancel one",
    builder: (argv) =>
      withTaskActionCommands(
        argv.command(taskListCommand(deps)).command(taskViewCommand(deps)),
        actionDeps,
      ).demandCommand(1, "A tasks command is required."),
    handler: () => undefined,
  };
}

export const tasksCommand = createTasksCommand();
