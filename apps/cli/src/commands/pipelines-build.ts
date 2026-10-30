import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { createScarnClient } from "@scarn/sdk/client";
import {
  buildPipelineDocuments,
  BuildScriptError,
  loadAuthenticatedSession,
  PIPELINE_BUILDER_DIR,
  resolveScarnBaseUrl,
  type BuiltFileReport,
  type ServerCatalogResult,
} from "@scarn/worker";
import { describeApiError } from "../lib/cli-api-client";
import { withReporter } from "../lib/command-output";
import { CliError } from "../lib/cli-error";
import { buildStepCatalog } from "../lib/pipeline-documents";
import type { BaseReporter } from "../lib/reporter-types";
import {
  pickProjectRef,
  PROJECT_ACTIONS,
  resolveCliProjectRef,
} from "../lib/resolve-project-ref";

/**
 * `scarn pipelines build [file]`: compile the `definePipeline` default
 * exports in `.scarn/pipeline-builder/` to `<key>.json` next to their
 * sources, and validate them. `--check` writes nothing and fails on missing
 * or out-of-date JSON, for CI.
 */

interface BuildArguments {
  file: string | undefined;
  check: boolean;
  project: string | undefined;
  baseUrl: string | undefined;
}

/**
 * The server's step catalog, read only when a pipeline uses steps it doesn't
 * define locally (`stepRef`). Never throws: signed out, no project, or a
 * failed request each become a reason the build reports next to the step.
 */
async function fetchServerCatalog(
  args: BuildArguments,
): Promise<ServerCatalogResult> {
  const baseUrl = resolveScarnBaseUrl(args.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    return { ok: false, reason: `not signed in to ${baseUrl}` };
  }
  const projectRef = await pickProjectRef(args.project);
  if (!projectRef) {
    return { ok: false, reason: "no project is configured" };
  }
  try {
    const { id: projectId } = await resolveCliProjectRef({
      baseUrl,
      ref: projectRef,
      action: PROJECT_ACTIONS.build,
    });
    const { data, error } = await createScarnClient(
      baseUrl,
    ).stepDefinitions.listStepDefinitions({
      query: { projectId },
      headers: {
        Authorization: `Bearer ${authenticated.profile.accessToken}`,
      },
    });
    if (error !== undefined) {
      return { ok: false, reason: describeApiError(error) };
    }
    return { ok: true, catalog: buildStepCatalog(data) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function display(path: string): string {
  return relative(process.cwd(), path) || basename(path);
}

function reportFile(
  reporter: BaseReporter,
  report: BuiltFileReport,
  check: boolean,
): void {
  const json = report.jsonPath === undefined ? "" : display(report.jsonPath);
  for (const warning of report.warnings) reporter.warn(warning);
  if (report.status === "failed") {
    reporter.error(`${display(report.source)} failed to build:`);
  } else if (report.status === "missing") {
    reporter.error(`${json} is missing. Run \`scarn pipelines build\`.`);
  } else if (report.status === "stale") {
    reporter.error(
      `${json} is out of date with ${display(report.source)}. Run \`scarn pipelines build\`.`,
    );
  } else if (report.errors.length === 0) {
    reporter.success(
      report.status === "written"
        ? `Wrote ${json}`
        : `${json} is up to date${check ? "" : " (unchanged)"}`,
    );
  } else if (report.status === "written") {
    reporter.info(`Wrote ${json}`);
  }
  if (report.errors.length > 0 && report.status !== "failed") {
    reporter.error(
      `"${report.key ?? ""}" has ${String(report.errors.length)} problem(s):`,
    );
  }
  for (const line of report.errors) reporter.error(`  ${line}`);
}

const runBuild = (args: ArgumentsCamelCase<BuildArguments>) =>
  withReporter("pipelines-build", async ({ reporter, logger }) => {
    const builderDir = resolve(process.cwd(), PIPELINE_BUILDER_DIR);
    if (!existsSync(builderDir)) {
      throw new CliError(
        "build_failed",
        `Pipeline builder directory not found at ${PIPELINE_BUILDER_DIR}. Run \`scarn pipelines init\` first.`,
      );
    }
    if (!existsSync(join(builderDir, "node_modules", "@scarn", "sdk"))) {
      throw new CliError(
        "build_failed",
        `Missing dependencies in ${PIPELINE_BUILDER_DIR}. Run \`bun install\` / \`npm install\` / \`pnpm install\` / \`yarn install\` inside that directory first.`,
      );
    }
    const file = args.file === undefined ? undefined : resolve(args.file);
    if (file !== undefined && !existsSync(file)) {
      throw new CliError("build_failed", `${args.file ?? ""} does not exist.`);
    }

    let result;
    try {
      result = await buildPipelineDocuments({
        builderDir,
        ...(file === undefined ? {} : { files: [file] }),
        check: args.check,
        fetchServerCatalog: () => fetchServerCatalog(args),
      });
    } catch (error) {
      if (error instanceof BuildScriptError) {
        throw new CliError("build_failed", error.message, { cause: error });
      }
      throw error;
    }
    logger.info({ files: result.files }, "Pipeline build finished");

    if (result.files.length === 0) {
      reporter.info(
        `No pipelines found${file === undefined ? ` in ${PIPELINE_BUILDER_DIR}` : ` in ${display(file)}`}: no file default-exports \`definePipeline(...)\` from "@scarn/sdk/pipelines".`,
      );
      return;
    }
    for (const report of result.files) reportFile(reporter, report, args.check);
    if (!result.ok) {
      throw new CliError(
        args.check ? "build_check_failed" : "pipeline_invalid",
        args.check
          ? "Pipeline JSON is missing, out of date or invalid."
          : "Some pipelines failed to build or validate.",
      );
    }
  });

export const buildCommand: CommandModule<object, BuildArguments> = {
  command: "build [file]",
  describe: `Compile TypeScript pipelines in ${PIPELINE_BUILDER_DIR} to <key>.json documents and validate them`,
  builder: (argv: Argv<object>) =>
    argv
      .positional("file", {
        describe: `One pipeline source file to build (defaults to every .ts file in ${PIPELINE_BUILDER_DIR})`,
        type: "string",
      })
      .option("check", {
        type: "boolean",
        default: false,
        describe:
          "Write nothing; fail if any JSON is missing or out of date (for CI)",
      })
      .option("project", {
        type: "string",
        describe:
          'The project whose steps resolve stepRef keys, as owner/slug (defaults to "project" in .scarn/scarn.jsonc)',
      })
      .option("baseUrl", {
        alias: "base-url",
        type: "string",
        describe: "Scarn app base URL",
      }),
  handler: runBuild,
};
