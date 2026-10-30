import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  createPipelineDefinitionsClient,
  PipelineDefinitionsApiError,
} from "@scarn/sdk/definitions/pipelines";
import {
  pipelineDocumentFileName,
  resolveScarnBaseUrl,
  serializePipelineDocument,
} from "@scarn/worker";
import { connectApi, describeApiError } from "../lib/cli-api-client";
import { withReporter } from "../lib/command-output";
import { CliError } from "../lib/cli-error";
import {
  activeVersionOf,
  findPipelineByKey,
  formatDocumentIssues,
  readPipelineDocumentFile,
  validatePipelineDocument,
} from "../lib/pipeline-documents";
import type { BaseReporter } from "../lib/reporter-types";
import {
  NO_PROJECT_MESSAGE,
  pickProjectRef,
  PROJECT_ACTIONS,
  resolveCliProjectRef,
  type ProjectAction,
} from "../lib/resolve-project-ref";
import { syncIdentityFromDisk } from "../lib/telemetry";

/**
 * The JSON pipeline document commands: `validate`, `publish`, `activate` and
 * `run`, plus the single-document form of `pull` (`pull --key`). Each one
 * resolves the project from `--project` or `.scarn/scarn.jsonc`.
 */

interface ProjectArguments {
  project: string | undefined;
  baseUrl: string | undefined;
}

const withProjectOptions = <T>(argv: Argv<T>) =>
  argv
    .option("project", {
      type: "string",
      describe:
        'The project, as owner/slug (defaults to "project" in .scarn/scarn.jsonc)',
    })
    .option("baseUrl", {
      alias: "base-url",
      type: "string",
      describe: "Scarn app base URL",
    });

async function connectProject(
  args: ProjectArguments,
  action: ProjectAction,
): Promise<
  Awaited<ReturnType<typeof connectApi>> & {
    baseUrl: string;
    projectId: string;
  }
> {
  const baseUrl = resolveScarnBaseUrl(args.baseUrl);
  const projectRef = await pickProjectRef(args.project);
  if (!projectRef) {
    throw new CliError("no_project_id", NO_PROJECT_MESSAGE);
  }
  const api = await connectApi(baseUrl);
  syncIdentityFromDisk(baseUrl);
  const { id: projectId } = await resolveCliProjectRef({
    baseUrl,
    ref: projectRef,
    action,
  });
  return { ...api, baseUrl, projectId };
}

async function findPipeline(
  baseUrl: string,
  headers: { Authorization: string },
  projectId: string,
  key: string,
) {
  const pipelines = await createPipelineDefinitionsClient(
    baseUrl,
  ).listByProjectId(projectId, { headers });
  return findPipelineByKey(pipelines, key);
}

async function requirePipeline(
  baseUrl: string,
  headers: { Authorization: string },
  projectId: string,
  key: string,
) {
  const pipeline = await findPipeline(baseUrl, headers, projectId, key);
  if (!pipeline) {
    throw new CliError(
      "pipeline_not_found",
      `No pipeline "${key}" in this project. Publish one with \`scarn pipelines publish <file>\`.`,
    );
  }
  return pipeline;
}

function reportIssues(
  reporter: BaseReporter,
  file: string,
  issues: readonly { path: string; message: string; hint?: string }[],
): never {
  for (const line of formatDocumentIssues(issues)) {
    reporter.error(line);
  }
  throw new CliError(
    "pipeline_invalid",
    `${file} has ${String(issues.length)} problem(s).`,
  );
}

// validate

interface ValidateArguments extends ProjectArguments {
  file: string;
}

const runValidate = (args: ArgumentsCamelCase<ValidateArguments>) =>
  withReporter("pipelines-validate", async ({ reporter }) => {
    const { document, key } = readPipelineDocumentFile(args.file);
    const { client, headers, projectId } = await connectProject(
      args,
      PROJECT_ACTIONS.validate,
    );

    const { data: steps, error } =
      await client.stepDefinitions.listStepDefinitions({
        query: { projectId },
        headers,
      });
    if (error !== undefined) {
      throw new Error(
        `Could not read the project's step definitions: ${describeApiError(error)}`,
      );
    }

    const result = validatePipelineDocument(document, steps);
    if (!result.ok) {
      reportIssues(reporter, args.file, result.errors);
    }
    reporter.success(`${args.file} is a valid pipeline "${key}".`);
  });

export const validateCommand: CommandModule<object, ValidateArguments> = {
  command: "validate <file>",
  describe:
    "Check a pipeline JSON document against the project's active step definitions",
  builder: (argv: Argv<object>) =>
    withProjectOptions(
      argv.positional("file", {
        describe: "Path to the pipeline JSON document",
        type: "string",
        demandOption: true,
      }),
    ),
  handler: runValidate,
};

// publish

interface PublishArguments extends ProjectArguments {
  file: string;
  name: string | undefined;
}

const runPublish = (args: ArgumentsCamelCase<PublishArguments>) =>
  withReporter("pipelines-publish", async ({ reporter }) => {
    const { document, key, title } = readPipelineDocumentFile(args.file);
    const { baseUrl, headers, projectId } = await connectProject(
      args,
      PROJECT_ACTIONS.publish,
    );
    const pipelines = createPipelineDefinitionsClient(baseUrl);

    try {
      const existing = await findPipeline(baseUrl, headers, projectId, key);
      if (!existing) {
        const created = await pipelines.create(
          { projectId, key, name: args.name ?? title ?? key, document },
          { headers },
        );
        const version = activeVersionOf(created)?.version ?? 1;
        reporter.success(
          `Created pipeline "${key}" and published version ${String(version)}.`,
        );
        return;
      }

      const result = await pipelines.publishVersion(existing.id, document, {
        headers,
      });
      reporter.success(
        result.published
          ? `Published "${key}" version ${String(result.version.version)}; it is now active.`
          : `"${key}" is unchanged since version ${String(result.version.version)}; nothing published.`,
      );
    } catch (error) {
      if (error instanceof PipelineDefinitionsApiError) {
        if (error.issues.length > 0) {
          reportIssues(reporter, args.file, error.issues);
        }
        throw new CliError(
          "pipeline_publish_failed",
          `Could not publish ${args.file}: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  });

export const publishCommand: CommandModule<object, PublishArguments> = {
  command: "publish <file>",
  describe:
    "Publish a pipeline JSON document as the pipeline's next active version",
  builder: (argv: Argv<object>) =>
    withProjectOptions(
      argv
        .positional("file", {
          describe: "Path to the pipeline JSON document",
          type: "string",
          demandOption: true,
        })
        .option("name", {
          type: "string",
          describe:
            "Display name when the pipeline is created (defaults to the document's title, then its key)",
        }),
    ),
  handler: runPublish,
};

// activate

interface ActivateArguments extends ProjectArguments {
  key: string;
  version: number;
}

const runActivate = (args: ArgumentsCamelCase<ActivateArguments>) =>
  withReporter("pipelines-activate", async ({ reporter }) => {
    const { baseUrl, headers, projectId } = await connectProject(
      args,
      PROJECT_ACTIONS.activate,
    );
    const pipeline = await requirePipeline(
      baseUrl,
      headers,
      projectId,
      args.key,
    );
    await createPipelineDefinitionsClient(baseUrl).activateVersion(
      pipeline.id,
      args.version,
      { headers },
    );
    reporter.success(
      `"${args.key}" version ${String(args.version)} is now active. New runs use it.`,
    );
  });

export const activateCommand: CommandModule<object, ActivateArguments> = {
  command: "activate <key> <version>",
  describe: "Make an earlier published version of a pipeline the active one",
  builder: (argv: Argv<object>) =>
    withProjectOptions(
      argv
        .version(false)
        .positional("key", {
          describe: "The pipeline key",
          type: "string",
          demandOption: true,
        })
        .positional("version", {
          describe: "The version number to activate",
          type: "number",
          demandOption: true,
        }),
    ),
  handler: runActivate,
};

// run

interface RunArguments extends ProjectArguments {
  key: string;
  workItemId: string;
  version: number | undefined;
}

const runRun = (args: ArgumentsCamelCase<RunArguments>) =>
  withReporter("pipelines-run", async ({ reporter }) => {
    const { baseUrl, client, headers, projectId } = await connectProject(
      args,
      PROJECT_ACTIONS.run,
    );
    const pipeline = await requirePipeline(
      baseUrl,
      headers,
      projectId,
      args.key,
    );

    const { data, error } =
      await client.pipelineExecutions.createPipelineExecution({
        body: {
          projectId,
          workItemId: args.workItemId,
          pipelineDefinitionId: pipeline.id,
          ...(args.version === undefined ? {} : { version: args.version }),
        },
        headers,
      });
    if (error !== undefined) {
      throw new CliError(
        "run_queue_failed",
        `Could not queue the run: ${describeApiError(error)}`,
      );
    }

    const versionLabel =
      args.version === undefined
        ? "the active version"
        : `version ${String(args.version)}`;
    reporter.success(
      `Queued run ${data.id} of "${args.key}" (${versionLabel}) on "${data.workItemTitle}".`,
    );
    process.stdout.write(`${data.id}\n`);
  });

export const runCommand: CommandModule<object, RunArguments> = {
  command: "run <key>",
  describe: "Queue a run of a pipeline against a work item",
  builder: (argv: Argv<object>) =>
    withProjectOptions(
      argv
        .version(false)
        .positional("key", {
          describe: "The pipeline key",
          type: "string",
          demandOption: true,
        })
        .option("workItemId", {
          alias: "work-item-id",
          type: "string",
          demandOption: true,
          describe: "The work item to run the pipeline against",
        })
        .option("version", {
          type: "number",
          describe:
            "Run this published version instead of the active one (rollback testing)",
        }),
    ),
  handler: runRun,
};

// pull --key

export interface PullDocumentArguments extends ProjectArguments {
  key: string;
  version: number | undefined;
  out: string | undefined;
}

/** `pull --key`: write one pipeline's document (active or `--version`) to a file. */
export const runPullDocument = (args: PullDocumentArguments) =>
  withReporter("pipelines-pull", async ({ reporter }) => {
    const { baseUrl, headers, projectId } = await connectProject(
      args,
      PROJECT_ACTIONS.pull,
    );
    const pipeline = await requirePipeline(
      baseUrl,
      headers,
      projectId,
      args.key,
    );

    const document =
      args.version === undefined
        ? activeVersionOf(pipeline)
        : await createPipelineDefinitionsClient(baseUrl).getVersion(
            pipeline.id,
            args.version,
            { headers },
          );
    if (!document) {
      throw new CliError(
        "pipeline_not_found",
        `Pipeline "${args.key}" has no published version.`,
      );
    }

    const path = resolve(args.out ?? pipelineDocumentFileName(args.key));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializePipelineDocument(document.definition), "utf8");
    reporter.success(
      `Wrote "${args.key}" version ${String(document.version)} to ${path}.`,
    );
  });
