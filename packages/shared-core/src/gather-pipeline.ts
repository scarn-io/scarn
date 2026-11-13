import { describeApiError } from "./lib/api-errors";
import type { ApiResult, AuthHeaders } from "./lib/api-result";
import type {
  PipelineDefinitionWithVersion,
  PipelineVersion,
  StepDefinitionSummary,
} from "./lib/pipeline-api-types";
import type { PipelineReadClient } from "./lib/pipeline-read-client";
import { findPipelineDefinition } from "./gather-runs";

/**
 * The reads behind `pipelines show`: the pipeline, one published version of
 * its document (the active one unless asked otherwise), and the step
 * definitions that version pins. {@link formatPipelineShow} renders it.
 */

/** One pinned step definition: loaded, or the reason it failed. */
export type PinnedStepDefinition =
  | { status: "loaded"; stepKey: string; definition: StepDefinitionSummary }
  | {
      status: "unavailable";
      stepKey: string;
      stepDefinitionId: string;
      reason: string;
    };

export type GatherPipelineShowOptions = {
  client: PipelineReadClient;
  headers: AuthHeaders;
  projectId: string;
  /** A pipeline key or id. */
  pipeline: string;
  /** A published version; defaults to the active one. */
  version?: number;
};

export type GatheredPipelineShow = {
  pipeline: PipelineDefinitionWithVersion;
  version: PipelineVersion;
  isActive: boolean;
  steps: PinnedStepDefinition[];
};

function unwrap<T>(what: string, result: ApiResult<T>): T {
  if (result.error?.status === 404) {
    throw new Error(`${what} not found.`);
  }
  if (result.error !== undefined) {
    throw new Error(
      `Could not load ${what}: ${describeApiError(result.error)}`,
    );
  }
  return result.data;
}

async function pinnedStep(
  client: PipelineReadClient,
  headers: AuthHeaders,
  stepKey: string,
  stepDefinitionId: string,
): Promise<PinnedStepDefinition> {
  try {
    const result = await client.stepDefinitions.getStepDefinition({
      path: { stepDefinitionId },
      headers,
    });
    return result.error === undefined
      ? { status: "loaded", stepKey, definition: result.data }
      : {
          status: "unavailable",
          stepKey,
          stepDefinitionId,
          reason: describeApiError(result.error),
        };
  } catch (error) {
    return {
      status: "unavailable",
      stepKey,
      stepDefinitionId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One pipeline's published document and the step definitions it pins. */
export async function gatherPipelineShow(
  options: GatherPipelineShowOptions,
): Promise<GatheredPipelineShow> {
  const { client, headers, projectId } = options;
  const definitions = unwrap(
    "pipelines",
    await client.pipelineDefinitions.listPipelineDefinitions({
      path: { projectId },
      query: { includeArchived: true },
      headers,
    }),
  );
  const pipeline = findPipelineDefinition(definitions, options.pipeline);
  const version =
    options.version === undefined
      ? pipeline.currentVersion
      : unwrap(
          `Version ${String(options.version)} of pipeline "${pipeline.key}"`,
          await client.pipelineDefinitions.getPipelineDefinitionVersion({
            path: {
              pipelineDefinitionId: pipeline.id,
              version: options.version,
            },
            headers,
          }),
        );
  if (version === null) {
    throw new Error(
      `Pipeline "${pipeline.key}" has no active version. Pass --version to show a published one.`,
    );
  }
  const steps = await Promise.all(
    version.steps.map((step) =>
      pinnedStep(client, headers, step.stepKey, step.stepDefinitionId),
    ),
  );
  return {
    pipeline,
    version,
    isActive: pipeline.currentVersion?.version === version.version,
    steps,
  };
}
