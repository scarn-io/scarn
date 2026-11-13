import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  cancelTask,
  loadTask,
  retryTask,
  type TaskActionClient,
} from "@scarn/shared-core";
import { resolveScarnBaseUrl } from "@scarn/worker";
import {
  asCliAction,
  realActionIo,
  type ActionIo,
} from "../lib/action-support";
import { connectApi, type AuthenticatedApi } from "../lib/cli-api-client";
import { withReporter } from "../lib/command-output";
import { withConfirmOption } from "../lib/confirm-action";
import { withBaseUrlOption } from "../lib/connect-project";
import { nextHint, writeJson, writeText } from "../lib/output";

/**
 * `scarn tasks retry` and `tasks cancel`: the safe actions on a Task. Cancel
 * asks first; retry does not.
 */

type ActionConnection = {
  client: TaskActionClient;
  headers: { Authorization: string };
};

export interface TaskActionDependencies {
  connect(args: { baseUrl: string | undefined }): Promise<ActionConnection>;
  io: ActionIo;
}

/** The generated client matches {@link TaskActionClient} only at runtime. */
const asActionClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as TaskActionClient;

export const realTaskActionDependencies: TaskActionDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asActionClient(api.client), headers: api.headers };
  },
  io: realActionIo,
};

interface TaskArguments {
  taskId: string;
  json: boolean;
  baseUrl: string | undefined;
}

const withTaskArguments = <T>(argv: Argv<T>) =>
  withBaseUrlOption(argv)
    .positional("taskId", {
      describe: "The Task ID",
      type: "string",
      demandOption: true,
    })
    .option("json", {
      describe: "Print the API response as a single JSON document",
      type: "boolean",
      default: false,
    });

const retryCommand = (
  deps: TaskActionDependencies,
): CommandModule<object, TaskArguments> => ({
  command: "retry <taskId>",
  describe:
    "Retry a failed or cancelled standalone Task (a pipeline step's Task is rerun with `runs rerun`)",
  builder: (argv: Argv<object>) => withTaskArguments(argv),
  handler: (args: ArgumentsCamelCase<TaskArguments>) =>
    withReporter("tasks-retry", () =>
      asCliAction(async () => {
        const { client, headers } = await deps.connect(args);
        const retried = await retryTask({
          client,
          headers,
          taskId: args.taskId,
        });
        if (args.json) {
          writeJson({ taskId: retried.taskId, taskRunId: retried.taskRunId });
          return;
        }
        writeText([
          retried.taskRunId === null
            ? `Retried Task ${retried.taskId}; its run starts once its blockers clear.`
            : `Retried Task ${retried.taskId} as Task run ${retried.taskRunId}.`,
          nextHint(`scarn tasks view ${retried.taskId}`),
          ...(retried.taskRunId === null
            ? []
            : [nextHint(`scarn logs ${retried.taskRunId} --follow`)]),
        ]);
      }),
    ),
});

interface CancelArguments extends TaskArguments {
  yes: boolean;
}

const cancelCommand = (
  deps: TaskActionDependencies,
): CommandModule<object, CancelArguments> => ({
  command: "cancel <taskId>",
  describe:
    "Cancel an agent Task; a pipeline step's Task cancels its whole run (asks first)",
  builder: (argv: Argv<object>) => withConfirmOption(withTaskArguments(argv)),
  handler: (args: ArgumentsCamelCase<CancelArguments>) =>
    withReporter("tasks-cancel", ({ reporter }) =>
      asCliAction(async () => {
        const { client, headers } = await deps.connect(args);
        const connection = { client, headers, taskId: args.taskId };
        const task = await loadTask(connection);
        const question =
          task.pipelineRunId === null
            ? `Cancel Task ${task.id} (${task.status})?`
            : `Cancel Task ${task.id} (${task.status})? It belongs to pipeline run ${task.pipelineRunId}, so the whole run is cancelled.`;
        if (!(await deps.io.confirm(question, args.yes))) {
          reporter.info("Nothing was cancelled.");
          return;
        }
        const cancelled = await cancelTask(connection);
        if (args.json) {
          writeJson(cancelled);
          return;
        }
        writeText([
          `Cancelled Task ${cancelled.taskId}.`,
          nextHint(`scarn tasks view ${cancelled.taskId}`),
        ]);
      }),
    ),
});

/** Registers the action verbs on `scarn tasks`, next to the reads. */
export const withTaskActionCommands = (
  argv: Argv<object>,
  deps: TaskActionDependencies,
) => argv.command(retryCommand(deps)).command(cancelCommand(deps));
