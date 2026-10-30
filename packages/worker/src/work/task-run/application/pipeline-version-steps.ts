import { z } from "zod";
import { ConfigurationError } from "../../../lib/errors";

/**
 * Reads the step definitions of a pipeline's active version from the
 * `getPipelineDefinition` response. Parsed rather than cast: the generated
 * client types the nullable `currentVersion` as `T | unknown`.
 */

const pinnedStepSchema = z.object({
  stepKey: z.string().min(1),
  stepDefinitionId: z.string().min(1),
});

const activeVersionSchema = z.object({
  definition: z.object({
    start: z.object({ to: z.string() }),
    nodes: z.record(
      z.string(),
      z.object({ kind: z.string(), step: z.string().optional() }),
    ),
  }),
  steps: z.array(pinnedStepSchema),
});

const pipelineWithActiveVersionSchema = z.object({
  currentVersion: activeVersionSchema.nullable(),
});

export type ActivePipelineVersion = z.infer<typeof activeVersionSchema>;

export function readActivePipelineVersion(
  pipelineDefinitionId: string,
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses an API response at the boundary
  pipeline: unknown,
): ActivePipelineVersion {
  if (pipeline === undefined || pipeline === null) {
    throw new ConfigurationError(
      `Pipeline definition ${pipelineDefinitionId} was not found.`,
    );
  }
  const parsed = pipelineWithActiveVersionSchema.safeParse(pipeline);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Pipeline definition ${pipelineDefinitionId} has an unreadable active version.`,
    );
  }
  if (parsed.data.currentVersion === null) {
    throw new ConfigurationError(
      `Pipeline definition ${pipelineDefinitionId} has no published version.`,
    );
  }
  return parsed.data.currentVersion;
}

/**
 * The distinct step definitions the version runs, in the order their nodes
 * appear in the document.
 */
export function listPinnedStepDefinitionIds(
  version: ActivePipelineVersion,
): string[] {
  const idByKey = new Map(
    version.steps.map((step) => [step.stepKey, step.stepDefinitionId]),
  );
  const ids = Object.values(version.definition.nodes).flatMap((node) => {
    const id = node.step === undefined ? undefined : idByKey.get(node.step);
    return id === undefined ? [] : [id];
  });
  return [...new Set(ids)];
}

/** The step definition of the node the pipeline starts at. */
export function resolveStartStepDefinitionId(
  pipelineDefinitionId: string,
  version: ActivePipelineVersion,
): string {
  const startNodeId = version.definition.start.to;
  const startNode = version.definition.nodes[startNodeId];
  const stepDefinitionId = version.steps.find(
    (step) => step.stepKey === startNode?.step,
  )?.stepDefinitionId;
  if (startNode?.kind !== "step" || stepDefinitionId === undefined) {
    throw new ConfigurationError(
      `Pipeline ${pipelineDefinitionId} does not start at a step (start node "${startNodeId}"), so there is no first step to dry-run.`,
    );
  }
  return stepDefinitionId;
}
