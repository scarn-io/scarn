import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { PipelineGraphVersionRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-version-repo";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { StepDefinitionEntity } from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";

/** The step definition a run's pipeline version pinned for a step node; null for any other node. */
export const stepDefinitionForNode = async (
  node: { pipelineGraphVersionId: UuidV7; nodeId: string },
  deps: {
    pipelineGraphVersionRepo: PipelineGraphVersionRepo;
    stepDefinitionRepo: StepDefinitionRepo;
  },
  dbExecutor?: DbExecutor,
): Promise<StepDefinitionEntity | null> => {
  const version = await deps.pipelineGraphVersionRepo.load(
    node.pipelineGraphVersionId,
    dbExecutor,
  );
  const documentNode = version?.definitionJson.nodes[node.nodeId];
  const stepDefinitionId =
    documentNode?.kind === "step"
      ? version?.stepDefinitionIdFor(documentNode.step)
      : null;
  return stepDefinitionId
    ? await deps.stepDefinitionRepo.load(stepDefinitionId, dbExecutor)
    : null;
};
