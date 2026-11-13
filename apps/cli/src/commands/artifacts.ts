import { existsSync } from "node:fs";
import path from "node:path";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  formatArtifactList,
  formatBytes,
  gatherArtifacts,
  resolveArtifactDownload,
} from "@scarn/shared-core";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import { withBaseUrlOption } from "../lib/connect-project";
import { writeJson, writeText } from "../lib/output";
import {
  realTaskRunDebugDependencies,
  type TaskRunDebugDependencies,
} from "../lib/task-run-debug-dependencies";

/**
 * `scarn artifacts list` and `scarn artifacts download`: the files a Task
 * run recorded (screenshots, traces, videos, …) and the uploads that failed.
 */

interface ListArguments {
  taskRunId: string;
  failures: boolean;
  json: boolean;
  baseUrl: string | undefined;
}

interface DownloadArguments {
  taskRunId: string;
  artifact: string;
  out: string | undefined;
  baseUrl: string | undefined;
}

const taskRunIdPositional = <T>(argv: Argv<T>) =>
  withBaseUrlOption(argv).positional("taskRunId", {
    describe: "The Task run ID",
    type: "string",
    demandOption: true,
  });

const listCommand = (
  deps: TaskRunDebugDependencies,
): CommandModule<object, ListArguments> => ({
  command: "list <taskRunId>",
  describe: "List the artifacts a Task run recorded",
  builder: (argv: Argv<object>) =>
    taskRunIdPositional(argv)
      .option("failures", {
        describe: "Also list the artifacts whose upload failed",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "Print the result as a single JSON document",
        type: "boolean",
        default: false,
      }),
  handler: (args: ArgumentsCamelCase<ListArguments>) =>
    withReporter("artifacts-list", async () => {
      const { client, headers } = await deps.connect(args);
      const gathered = await gatherArtifacts({
        client,
        headers,
        taskRunId: args.taskRunId,
        failures: args.failures,
      });
      if (args.json) writeJson(gathered);
      else writeText(formatArtifactList(gathered));
    }),
});

const downloadCommand = (
  deps: TaskRunDebugDependencies,
): CommandModule<object, DownloadArguments> => ({
  command: "download <taskRunId> <artifact>",
  describe:
    "Download an artifact (by id or path) to --out, or ./<file name> by default",
  builder: (argv: Argv<object>) =>
    taskRunIdPositional(argv)
      .positional("artifact", {
        describe: "The artifact ID, its path, or its file name",
        type: "string",
        demandOption: true,
      })
      .option("out", {
        describe:
          "Where to save it (default ./<file name>); an existing file is never overwritten",
        type: "string",
      }),
  handler: (args: ArgumentsCamelCase<DownloadArguments>) =>
    withReporter("artifacts-download", async () => {
      const { client, headers } = await deps.connect(args);
      const { artifact, url } = await resolveArtifactDownload({
        client,
        headers,
        taskRunId: args.taskRunId,
        ref: args.artifact,
      });
      const outPath = path.resolve(
        args.out ?? path.basename(artifact.relativeStorePath),
      );
      if (existsSync(outPath)) {
        throw new CliError(
          "invalid_usage",
          `${outPath} already exists; pass --out with a new path.`,
        );
      }
      const { bytes } = await deps.download(url, outPath);
      writeText([
        `Saved ${artifact.relativeStorePath} (${formatBytes(bytes)}) to ${outPath}`,
        "",
        `→ scarn artifacts list ${args.taskRunId}`,
      ]);
    }),
});

/** Builds `scarn artifacts`; tests pass fake dependencies. */
export function createArtifactsCommand(
  deps: TaskRunDebugDependencies = realTaskRunDebugDependencies,
): CommandModule<object, object> {
  return {
    command: "artifacts <command>",
    describe: "List and download a Task run's artifacts",
    builder: (argv) =>
      argv
        .command(listCommand(deps))
        .command(downloadCommand(deps))
        .demandCommand(1, "An artifacts command is required."),
    handler: () => undefined,
  };
}

export const artifactsCommand = createArtifactsCommand();
