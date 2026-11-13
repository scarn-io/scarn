import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  formatPipelineShow,
  gatherPipelineShow,
  type PipelineReadClient,
} from "@scarn/shared-core";
import type { AuthenticatedApi } from "../lib/cli-api-client";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import {
  connectProject,
  withProjectOptions,
  type ProjectArguments,
} from "../lib/connect-project";
import { writeJson, writeText } from "../lib/output";
import { PROJECT_ACTIONS } from "../lib/resolve-project-ref";

/**
 * `scarn pipelines show`: print one published pipeline document, the active
 * version unless `--version` names another.
 */

type PipelineReadConnection = {
  client: PipelineReadClient;
  headers: { Authorization: string };
  projectId: string;
};

/** What `pipelines show` reaches the API through; tests pass a fake. */
export interface PipelineShowDependencies {
  connectProject(args: ProjectArguments): Promise<PipelineReadConnection>;
}

/**
 * The generated `ScarnClient` types every nullable field as `unknown`, so it
 * matches {@link PipelineReadClient} at runtime but not structurally; this
 * is the one place it is asserted.
 */
const asReadClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as PipelineReadClient;

export const realPipelineShowDependencies: PipelineShowDependencies = {
  async connectProject(args) {
    const api = await connectProject(args, PROJECT_ACTIONS.inspect);
    return {
      client: asReadClient(api.client),
      headers: api.headers,
      projectId: api.projectId,
    };
  },
};

interface ShowArguments extends ProjectArguments {
  pipeline: string;
  version: number | undefined;
  json: boolean;
}

/** Builds `pipelines show`; tests pass fake dependencies. */
export const createShowCommand = (
  deps: PipelineShowDependencies = realPipelineShowDependencies,
): CommandModule<object, ShowArguments> => ({
  command: "show <pipeline>",
  describe:
    "Show a published pipeline document: its steps and edges, or the document itself with --json",
  builder: (argv: Argv<object>) =>
    withProjectOptions(argv)
      .version(false)
      .positional("pipeline", {
        describe: "The pipeline, by key or id",
        type: "string",
        demandOption: true,
      })
      .option("version", {
        type: "number",
        describe: "Show this published version instead of the active one",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print the pipeline version as a single JSON document",
      }),
  handler: (args: ArgumentsCamelCase<ShowArguments>) =>
    withReporter("pipelines-show", async () => {
      if (
        args.version !== undefined &&
        (!Number.isInteger(args.version) || args.version < 1)
      ) {
        throw new CliError(
          "invalid_usage",
          `--version must be a positive whole number, got ${String(args.version)}.`,
        );
      }
      const { client, headers, projectId } = await deps.connectProject(args);
      const gathered = await gatherPipelineShow({
        client,
        headers,
        projectId,
        pipeline: args.pipeline,
        version: args.version,
      });
      if (args.json) writeJson(gathered.version);
      else writeText(formatPipelineShow(gathered));
    }),
});

export const showCommand = createShowCommand();
