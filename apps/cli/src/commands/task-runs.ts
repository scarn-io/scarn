import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { formatTaskRunView, gatherTaskRunView } from "@scarn/shared-core";
import { withReporter } from "../lib/command-output";
import { withBaseUrlOption } from "../lib/connect-project";
import { writeJson, writeText } from "../lib/output";
import {
  realTaskReadDependencies,
  type TaskReadDependencies,
} from "../lib/task-read-dependencies";

/**
 * `scarn task-runs view`: one Task run's status, worker lease, timings,
 * result and artifacts.
 */

interface ViewArguments {
  taskRunId: string;
  json: boolean;
  baseUrl: string | undefined;
}

const taskRunViewCommand = (
  deps: TaskReadDependencies,
): CommandModule<object, ViewArguments> => ({
  command: "view <taskRunId>",
  describe:
    "Show a Task run: status, worker and lease, timings, result and artifacts",
  builder: (argv: Argv<object>) =>
    withBaseUrlOption(argv)
      .positional("taskRunId", {
        describe: "The Task run ID",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe:
          "Print the Task run and its artifacts as a single JSON document",
        type: "boolean",
        default: false,
      }),
  handler: (args: ArgumentsCamelCase<ViewArguments>) =>
    withReporter("task-runs-view", async () => {
      const { client, headers } = await deps.connect(args);
      const gathered = await gatherTaskRunView({
        client,
        headers,
        taskRunId: args.taskRunId,
      });
      if (args.json) writeJson(gathered);
      else writeText(formatTaskRunView(gathered));
    }),
});

/** Builds `scarn task-runs`; tests pass fake read dependencies. */
export function createTaskRunsCommand(
  deps: TaskReadDependencies = realTaskReadDependencies,
): CommandModule<object, object> {
  return {
    command: "task-runs <command>",
    describe: "Read a Task run",
    builder: (argv) =>
      argv
        .command(taskRunViewCommand(deps))
        .demandCommand(1, "A task-runs command is required."),
    handler: () => undefined,
  };
}

export const taskRunsCommand = createTaskRunsCommand();
