import type { PipelineDefinitionSummary } from "./run-api-types";

/**
 * Minimal, nullable-correct mirrors of the pipeline definition response
 * bodies `pipelines show` reads (see `./api-types.ts` for why this package
 * does not import the generated types). `--json` prints the whole version
 * body as received.
 */

/** A step key pinned to the step definition version a pipeline version uses. */
export type PinnedStep = { stepKey: string; stepDefinitionId: string };

/** `GET /pipeline-definitions/{id}/versions/{v}`. */
export type PipelineVersion = {
  id: string;
  pipelineDefinitionId: string;
  version: number;
  schemaVersion: number;
  contentHash: string;
  definition: Record<string, unknown>;
  steps: PinnedStep[];
  createdAt: string;
};

/** One row of `GET /projects/{id}/pipeline-definitions`, with its active version. */
export type PipelineDefinitionWithVersion = PipelineDefinitionSummary & {
  currentVersion: PipelineVersion | null;
};

/** `GET /step-definitions/{id}`, the fields `pipelines show` labels steps with. */
export type StepDefinitionSummary = {
  id: string;
  key: string;
  name: string;
  version: number;
  kind: "built_in" | "user_defined" | "code";
};
