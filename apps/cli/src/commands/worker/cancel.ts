/**
 * `scarn worker cancel <taskRunId> [--yes]`: cancels a run's Task on the
 * server, then stops the run on this machine's worker when it is the one
 * running it. A run on another worker (or with no local worker) stops on
 * that worker's next heartbeat, once the server has cancelled it.
 *
 * Code Tasks can't be stopped and are refused before anything is asked. A
 * Task a pipeline step owns cancels its whole pipeline run, so that asks
 * first; `--yes` skips the question.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  ActionError,
  actionErrorKind,
  cancelTask,
  loadTask,
  type TaskActionClient,
  type TaskReadClient,
  type TaskRunDetail,
} from "@scarn/shared-core";
import { resolveScarnBaseUrl, resolveWorkerInstance } from "@scarn/worker";
import {
  asCliAction,
  realActionIo,
  type ActionIo,
} from "../../lib/action-support";
import { CliError } from "../../lib/cli-error";
import {
  connectApi,
  describeApiError,
  type AuthenticatedApi,
} from "../../lib/cli-api-client";
import { withReporter } from "../../lib/command-output";
import { withConfirmOption } from "../../lib/confirm-action";
import { withBaseUrlOption } from "../../lib/connect-project";
import type { BaseReporter } from "../../lib/reporter-types";
import {
  connectToWorker,
  controlData,
  type ConnectToWorkerDeps,
} from "./connect";

export type CancelClient = TaskActionClient & Pick<TaskReadClient, "taskRuns">;

export type CancelConnection = {
  client: CancelClient;
  headers: { Authorization: string };
};

export type WorkerCancelDeps = ConnectToWorkerDeps & {
  connect?: ((baseUrl: string) => Promise<CancelConnection>) | undefined;
  io?: Pick<ActionIo, "confirm"> | undefined;
};

export type WorkerCancelArguments = {
  taskRunId: string;
  yes: boolean;
  baseUrl: string | undefined;
};

export const PIPELINE_CANCEL_QUESTION =
  "This cancels the whole pipeline run. Continue?";

/** The generated client matches {@link CancelClient} only at runtime. */
const asCancelClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as CancelClient;

async function realConnect(baseUrl: string): Promise<CancelConnection> {
  const api = await connectApi(baseUrl);
  return { client: asCancelClient(api.client), headers: api.headers };
}

async function loadTaskRun(
  connection: CancelConnection,
  taskRunId: string,
): Promise<TaskRunDetail> {
  const result = await connection.client.taskRuns.getTaskRun({
    path: { taskRunId },
    headers: connection.headers,
  });
  if (result.error === undefined) return result.data;
  if (result.error.status === 404) {
    throw new ActionError("not_found", `Task run ${taskRunId} not found.`);
  }
  throw new ActionError(
    actionErrorKind(result.error.status),
    `Could not load Task run ${taskRunId}: ${describeApiError(result.error)}`,
  );
}

async function abortLocally(
  instance: string,
  taskRunId: string,
  reporter: BaseReporter,
  deps: ConnectToWorkerDeps,
): Promise<boolean> {
  try {
    const worker = await connectToWorker(
      instance,
      { checkVersion: true },
      deps,
    );
    if (!worker) return false;
    const { found } = await controlData(
      `stop run ${taskRunId} on the worker`,
      worker.client.runs({ taskRunId }).abort.post(),
    );
    return found;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    reporter.warn(error.message);
    return false;
  }
}

export async function runWorkerCancel(
  arguments_: WorkerCancelArguments,
  deps: WorkerCancelDeps = {},
): Promise<void> {
  await withReporter("worker-cancel-command", ({ reporter }) =>
    asCliAction(async () => {
      const { taskRunId } = arguments_;
      const connection = await (deps.connect ?? realConnect)(
        resolveScarnBaseUrl(arguments_.baseUrl),
      );
      const run = await loadTaskRun(connection, taskRunId);
      const task = await loadTask({ ...connection, taskId: run.taskId });
      if (task.kind === "code") {
        throw new ActionError(
          "rejected",
          `Task ${task.id} is a code Task, which can't be stopped`,
        );
      }
      if (task.pipelineRunId !== null) {
        const io = deps.io ?? realActionIo;
        if (!(await io.confirm(PIPELINE_CANCEL_QUESTION, arguments_.yes))) {
          reporter.info("Nothing was cancelled.");
          return;
        }
      }
      await cancelTask({ ...connection, taskId: task.id });
      const instance = resolveWorkerInstance();
      if (await abortLocally(instance, taskRunId, reporter, deps)) {
        reporter.success(
          `Cancelled Task ${task.id} and stopped run ${taskRunId} on worker instance ${instance}.`,
        );
        return;
      }
      reporter.success(
        `The server cancelled Task ${task.id}. Run ${taskRunId} is not on worker instance ${instance}; ` +
          "whichever worker owns it stops it on its next heartbeat.",
      );
    }),
  );
}

export function createWorkerCancelCommand(
  deps: WorkerCancelDeps = {},
): CommandModule<object, WorkerCancelArguments> {
  return {
    command: "cancel <taskRunId>",
    describe:
      "Cancel a Task run's Task on the server and stop the run on this worker",
    builder: (argv: Argv<object>) =>
      withConfirmOption(withBaseUrlOption(argv)).positional("taskRunId", {
        describe: "The Task run ID",
        type: "string",
        demandOption: true,
      }),
    handler: (arguments_: ArgumentsCamelCase<WorkerCancelArguments>) =>
      runWorkerCancel(arguments_, deps),
  };
}

export const workerCancelCommand = createWorkerCancelCommand();
