import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  RUN_DISPLAY_STATUSES,
  formatRunList,
  formatVisitThread,
  gatherRunList,
  gatherVisitThread,
  type RunDisplayStatus,
  type RunReadClient,
} from "@scarn/shared-core";
import { resolveScarnBaseUrl } from "@scarn/worker";
import { connectApi, type AuthenticatedApi } from "../lib/cli-api-client";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import {
  connectProject,
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
import { PROJECT_ACTIONS } from "../lib/resolve-project-ref";
import {
  createWorkItemRefPorts,
  resolveWorkItemRef,
  type ResolvedWorkItemRef,
} from "../lib/resolve-work-item-ref";
import {
  realRunActionDependencies,
  withRunActionCommands,
  type RunActionDependencies,
} from "./runs-actions";

/**
 * `scarn runs list` and `scarn runs thread`: find pipeline runs and read a
 * step's message thread. The action verbs live in `./runs-actions.ts`.
 */

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

type ReadConnection = {
  client: RunReadClient;
  headers: { Authorization: string };
};

/** What the read verbs reach the API through; tests pass fakes. */
export interface RunReadDependencies {
  connect(args: { baseUrl: string | undefined }): Promise<ReadConnection>;
  connectProject(
    args: ProjectArguments,
  ): Promise<ReadConnection & { projectId: string }>;
  resolveRef(ref: string, args: ProjectArguments): Promise<ResolvedWorkItemRef>;
}

/**
 * The generated `ScarnClient` types every nullable field as `unknown`, so it
 * matches {@link RunReadClient} at runtime but not structurally; this
 * is the one place it is asserted.
 */
const asReadClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as RunReadClient;

export const realRunReadDependencies: RunReadDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asReadClient(api.client), headers: api.headers };
  },
  async connectProject(args) {
    const api = await connectProject(args, PROJECT_ACTIONS.inspect);
    return {
      client: asReadClient(api.client),
      headers: api.headers,
      projectId: api.projectId,
    };
  },
  resolveRef: (ref, args) =>
    resolveWorkItemRef(ref, createWorkItemRefPorts(args)),
};

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

function isDisplayStatus(value: string): value is RunDisplayStatus {
  return (RUN_DISPLAY_STATUSES as readonly string[]).includes(value);
}

function parseStatus(status: string | undefined): RunDisplayStatus | undefined {
  if (status === undefined || isDisplayStatus(status)) return status;
  throw new CliError(
    "invalid_usage",
    `Invalid --status "${status}". Expected one of: ${RUN_DISPLAY_STATUSES.join(", ")}.`,
  );
}

// list

interface ListArguments extends ProjectArguments, OutputArguments {
  workItem: string | undefined;
  pipeline: string | undefined;
  status: string | undefined;
}

const runListCommand = (
  deps: RunReadDependencies,
): CommandModule<object, ListArguments> => ({
  command: "list",
  describe: "List the project's pipeline runs, newest first",
  builder: (argv: Argv<object>) =>
    withOutputOptions(withProjectOptions(argv))
      .option("workItem", {
        alias: "work-item",
        type: "string",
        describe: "Only this work item's runs: its id, tracker URL, or key",
      })
      .option("pipeline", {
        type: "string",
        describe: "Only runs of this pipeline, by key or id",
      })
      .option("status", {
        type: "string",
        describe: RUN_DISPLAY_STATUSES.join(", "),
      }),
  handler: (args: ArgumentsCamelCase<ListArguments>) =>
    withReporter("runs-list", async () => {
      const limit = listLimit(args.limit);
      const status = parseStatus(args.status);
      const { client, headers, projectId } = await deps.connectProject(args);
      const workItemId =
        args.workItem === undefined
          ? undefined
          : (await deps.resolveRef(args.workItem, args)).workItemId;
      const gathered = await gatherRunList({
        client,
        headers,
        projectId,
        pipeline: args.pipeline,
        workItemId,
        status,
        limit,
      });
      if (args.json) writeJson(gathered.page);
      else writeText(formatRunList(gathered));
    }),
});

// thread

interface ThreadArguments {
  runId: string;
  step: string;
  attempt: number | undefined;
  json: boolean;
  baseUrl: string | undefined;
}

const runThreadCommand = (
  deps: RunReadDependencies,
): CommandModule<object, ThreadArguments> => ({
  command: "thread <runId>",
  describe: "Show the messages sent to a step's Task runs",
  builder: (argv: Argv<object>) =>
    withBaseUrlOption(argv)
      .positional("runId", {
        describe: "The pipeline run ID",
        type: "string",
        demandOption: true,
      })
      .option("step", {
        describe: "The step key whose thread to show",
        type: "string",
        demandOption: true,
      })
      .option("attempt", {
        describe:
          "Which visit to the step, 1 for the first (defaults to the latest)",
        type: "number",
      })
      .option("json", {
        describe: "Print the thread as a single JSON document",
        type: "boolean",
        default: false,
      }),
  handler: (args: ArgumentsCamelCase<ThreadArguments>) =>
    withReporter("runs-thread", async () => {
      if (
        args.attempt !== undefined &&
        (!Number.isInteger(args.attempt) || args.attempt < 1)
      ) {
        throw new CliError(
          "invalid_usage",
          `--attempt must be a positive whole number, got ${String(args.attempt)}.`,
        );
      }
      const { client, headers } = await deps.connect(args);
      const gathered = await gatherVisitThread({
        client,
        headers,
        runId: args.runId,
        stepKey: args.step,
        attempt: args.attempt,
      });
      if (args.json) writeJson(gathered.thread);
      else writeText(formatVisitThread(gathered));
    }),
});

// parent

/** Builds `scarn runs`; tests pass fake dependencies. */
export function createRunsCommand(
  deps: RunReadDependencies = realRunReadDependencies,
  actionDeps: RunActionDependencies = realRunActionDependencies,
): CommandModule<object, object> {
  return {
    command: "runs <command>",
    describe:
      "List pipeline runs, read their steps' threads, and rerun, message or cancel them",
    builder: (argv) =>
      withRunActionCommands(
        argv.command(runListCommand(deps)).command(runThreadCommand(deps)),
        actionDeps,
      ).demandCommand(1, "A runs command is required."),
    handler: () => undefined,
  };
}

export const runsCommand = createRunsCommand();
