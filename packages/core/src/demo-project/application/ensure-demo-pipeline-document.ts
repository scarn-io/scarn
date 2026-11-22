import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import { noopAnalytics } from "@scarn/core/lib/analytics/analytics-port";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { createPipelineGraph } from "@scarn/core/pipeline-definitions/pipeline-graph/application/create-pipeline-graph";
import { publishPipelineVersion } from "@scarn/core/pipeline-definitions/pipeline-graph/application/publish-pipeline-graph-version";
import { upsertStepDefinition } from "@scarn/core/pipeline-definitions/step-definition/application/upsert-step-definition";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";

export type DemoStepDefinitionInput = {
  key: string;
  name: string;
  description: string;
  prompt: string;
};

/**
 * Brings each of a demo pipeline's step definitions in line with its fixture.
 * Every demo step accepts and returns any object, so the document's
 * transitions can reference any result field.
 */
export const ensureDemoStepDefinitions = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  steps: readonly DemoStepDefinitionInput[],
): Promise<void> => {
  for (const step of steps) {
    await upsertStepDefinition(
      {
        projectId,
        key: step.key,
        name: step.name,
        description: step.description,
        prompt: step.prompt,
        version: 1,
        kind: "user_defined",
        environment: null,
        inputSchemaJson: { type: "object" },
        resultSchemaJson: { type: "object" },
        opencodeMcpJson: null,
        healthChecksJson: null,
        status: "active",
      },
      {
        userAuthz,
        stepDefinitionRepo: appContext.stepDefinitionRepo,
        taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
        environmentRepo: appContext.environmentRepo,
        timeProvider: appContext.timeProvider,
      },
    );
  }
};

/**
 * Creates the demo pipeline with `document` as version 1, or publishes
 * `document` to the existing one. Publishing is a no-op when the document and
 * pinned steps hash the same as the latest version, so re-seeding an
 * unchanged fixture writes nothing while an edited one lands as a new version.
 */
export const ensureDemoPipelineDocument = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  pipeline: { name: string; document: PipelineDocument },
): Promise<UuidV7> => {
  const deps = {
    pipelineGraphRepo: appContext.pipelineGraphRepo,
    pipelineGraphVersionRepo: appContext.pipelineGraphVersionRepo,
    stepDefinitionRepo: appContext.stepDefinitionRepo,
    timeProvider: appContext.timeProvider,
  };
  const existing = await appContext.pipelineGraphRepo.findHandleByKey(
    projectId,
    pipeline.document.key,
  );
  if (existing) {
    Result.unwrap(
      await publishPipelineVersion(
        { pipelineDefinitionId: existing.id, document: pipeline.document },
        { ...deps, userAuthz },
      ),
    );
    return existing.id;
  }
  const created = Result.unwrap(
    await createPipelineGraph(
      {
        projectId,
        key: pipeline.document.key,
        name: pipeline.name,
        document: pipeline.document,
      },
      { ...deps, userAuthz, analytics: noopAnalytics, via: "push" },
    ),
  );
  return created.id;
};
