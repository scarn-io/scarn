import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { PipelineGraphRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-repo";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { ManagedConnectionUsageContract } from "../contracts/managed-connection-contracts";
import {
  managedConnectionNotFound,
  requireConnectionReader,
} from "./managed-connection-access";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedLaunchRepo } from "./managed-launch-repo";

type LoadManagedConnectionUsageDeps = {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: Pick<ManagedConnectionRepo, "findById">;
  stepDefinitionRepo: Pick<
    StepDefinitionRepo,
    "listLatestActiveByManagedConnectionName"
  >;
  pipelineGraphRepo: Pick<PipelineGraphRepo, "listCurrentByStepDefinitionIds">;
  managedLaunchRepo: Pick<ManagedLaunchRepo, "countOpenRunsForConnection">;
};

/** Latest active step references and open runs pinned to a member's connection. */
export const loadManagedConnectionUsage = async (
  input: { projectId: UuidV7; connectionId: UuidV7 },
  deps: LoadManagedConnectionUsageDeps,
): Promise<ManagedConnectionUsageContract> => {
  await requireConnectionReader(deps.userAuthz, input.projectId);
  const connection = await deps.managedConnectionRepo.findById(
    input.projectId,
    input.connectionId,
  );
  if (!connection) {
    throw managedConnectionNotFound(input.connectionId);
  }
  const [steps, liveRuns] = await Promise.all([
    deps.stepDefinitionRepo.listLatestActiveByManagedConnectionName(
      input.projectId,
      connection.name,
    ),
    deps.managedLaunchRepo.countOpenRunsForConnection(
      input.projectId,
      input.connectionId,
    ),
  ]);
  const pipelineUses =
    await deps.pipelineGraphRepo.listCurrentByStepDefinitionIds(
      input.projectId,
      steps.map((step) => step.id),
    );
  const pipelinesByStep = new Map<
    UuidV7,
    ManagedConnectionUsageContract["steps"][number]["pipelines"]
  >();
  for (const { stepDefinitionId, pipeline } of pipelineUses) {
    const pipelines = pipelinesByStep.get(stepDefinitionId) ?? [];
    pipelines.push({
      id: pipeline.id,
      key: pipeline.key,
      name: pipeline.name,
    });
    pipelinesByStep.set(stepDefinitionId, pipelines);
  }
  return {
    steps: steps.map((step) => ({
      id: step.id,
      key: step.key,
      name: step.name,
      pipelines: pipelinesByStep.get(step.id) ?? [],
    })),
    liveRuns,
  };
};
