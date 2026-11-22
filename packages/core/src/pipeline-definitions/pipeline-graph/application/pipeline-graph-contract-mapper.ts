import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type {
  PipelineDefinitionContract,
  PipelineVersionContract,
  PipelineVersionSummaryContract,
} from "../contracts/pipeline-graph-contracts";
import type { PipelineGraphVersionEntity } from "../domain/pipeline-graph-version-entity";
import type { ResolvedPipelineGraph } from "./pipeline-graph-repo";

const requiredIsoString = (value: Date | null | undefined): string =>
  value?.toISOString() ?? new Date(0).toISOString();

export const pipelineGraphVersionEntityToSummary = (
  version: PipelineGraphVersionEntity,
): PipelineVersionSummaryContract => ({
  id: version.id,
  pipelineDefinitionId: version.pipelineGraphId,
  version: version.version,
  schemaVersion: version.schemaVersion,
  contentHash: version.contentHash,
  createdAt: requiredIsoString(version.createdAt),
});

export const pipelineGraphVersionEntityToContract = (
  version: PipelineGraphVersionEntity,
): PipelineVersionContract => ({
  ...pipelineGraphVersionEntityToSummary(version),
  definition: version.definitionJson as unknown as AnyJsonObject,
  steps: version.steps.map((step) => ({
    stepKey: step.stepKey,
    stepDefinitionId: step.stepDefinitionId,
  })),
});

export const pipelineGraphEntityToContract = ({
  handle,
  currentVersion,
}: ResolvedPipelineGraph): PipelineDefinitionContract => ({
  id: handle.id,
  projectId: handle.projectId,
  key: handle.key,
  name: handle.name,
  archivedAt: handle.archivedAt?.toISOString() ?? null,
  currentVersion: currentVersion
    ? pipelineGraphVersionEntityToContract(currentVersion)
    : null,
  createdAt: requiredIsoString(handle.createdAt),
  updatedAt: requiredIsoString(handle.updatedAt),
});
