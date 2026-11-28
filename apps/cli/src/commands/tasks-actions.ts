import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  cancelTask,
  decideTaskAccess,
  loadTask,
  retryTask,
  type AccessDecision,
  type TaskAccessClient,
  type TaskActionClient,
} from "@scarn/shared-core";
import { grantSentence } from "@scarn/sdk/definitions/steps/work-item-features";
import { resolveScarnBaseUrl } from "@scarn/worker";
import { CliError } from "../lib/cli-error";
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
 * `scarn tasks retry`, `tasks cancel` and `tasks access`: the safe actions on
 * a Task. Cancel asks first; retry and access do not.
 */

type ActionConnection = {
  client: TaskActionClient & TaskAccessClient;
};

export interface TaskActionDependencies {
  connect(args: { baseUrl: string | undefined }): Promise<ActionConnection>;
  io: ActionIo;
}

/** The generated client matches {@link TaskActionClient} only at runtime. */
const asActionClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as TaskActionClient & TaskAccessClient;

export const realTaskActionDependencies: TaskActionDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asActionClient(api.client) };
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
        const { client } = await deps.connect(args);
        const retried = await retryTask({
          client,
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
        const { client } = await deps.connect(args);
        const connection = { client, taskId: args.taskId };
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

interface AccessArguments extends TaskArguments {
  approve: boolean;
  deny: boolean;
  only: string[] | undefined;
  labels: string[] | undefined;
  note: string | undefined;
}

const SELECTOR = /^[a-z]+:[a-z]+$/;

function accessDecision(args: AccessArguments): AccessDecision {
  if (args.approve === args.deny) {
    throw new CliError(
      "invalid_usage",
      "Pass exactly one of --approve or --deny.",
    );
  }
  const note = args.note?.trim() === "" ? undefined : args.note;
  if (args.deny) {
    if (args.only !== undefined || args.labels !== undefined) {
      throw new CliError(
        "invalid_usage",
        "--only and --labels go with --approve, not --deny.",
      );
    }
    return { kind: "deny", note };
  }
  const only = args.only ?? [];
  const malformed = only.filter((selector) => !SELECTOR.test(selector));
  if (malformed.length > 0) {
    throw new CliError(
      "invalid_usage",
      `--only takes action:scope, such as comment:self or create:children; got ${malformed.join(", ")}.`,
    );
  }
  return { kind: "approve", only, labels: args.labels ?? [], note };
}

const accessCommand = (
  deps: TaskActionDependencies,
): CommandModule<object, AccessArguments> => ({
  command: "access <taskId>",
  describe:
    "Approve (all or some) or deny the agent's pending request for more access",
  builder: (argv: Argv<object>) =>
    withTaskArguments(argv)
      .option("approve", {
        describe: "Approve the requested grants (all, or those --only picks)",
        type: "boolean",
        default: false,
      })
      .option("deny", {
        describe: "Deny the request; nothing is granted",
        type: "boolean",
        default: false,
      })
      .option("only", {
        describe:
          "Approve only this requested grant, as action:scope (repeat for several)",
        type: "string",
        array: true,
      })
      .option("labels", {
        describe:
          "Approve only these of the labels the selected grants ask for (repeat for several)",
        type: "string",
        array: true,
      })
      .option("note", {
        describe: "A note for the agent",
        type: "string",
      }),
  handler: (args: ArgumentsCamelCase<AccessArguments>) =>
    withReporter("tasks-access", () =>
      asCliAction(async () => {
        const decision = accessDecision(args);
        const { client } = await deps.connect(args);
        const decided = await decideTaskAccess({
          client,
          taskId: args.taskId,
          decision,
        });
        if (args.json) {
          writeJson(decided);
          return;
        }
        writeText([
          decided.approved.length === 0
            ? `Denied the access request of Task ${decided.taskId}; it resumes without new access.`
            : `Approved ${String(decided.approved.length)} of ${String(decided.requested.length)} requested grants for Task ${decided.taskId}; it resumes with:`,
          ...decided.approved.map((grant) => `  ${grantSentence(grant)}`),
          nextHint(`scarn tasks view ${decided.taskId}`),
        ]);
      }),
    ),
});

/** Registers the action verbs on `scarn tasks`, next to the reads. */
export const withTaskActionCommands = (
  argv: Argv<object>,
  deps: TaskActionDependencies,
) =>
  argv
    .command(retryCommand(deps))
    .command(cancelCommand(deps))
    .command(accessCommand(deps));
