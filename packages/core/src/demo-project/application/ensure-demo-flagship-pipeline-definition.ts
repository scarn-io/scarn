import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { upsertWorkItem } from "@scarn/core/work-items/work-item/application/upsert-work-item";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type {
  DemoFlagshipPipelineFixture,
  EnsureDemoFlagshipExecutionInput,
} from "./demo-flagship-pipeline-types";
import {
  ensureDemoPipelineDocument,
  ensureDemoStepDefinitions,
} from "./ensure-demo-pipeline-document";

/**
 * Pipeline/work-item setup for `seed-demo-flagship-execution.ts` — split into
 * its own module purely to stay under the repo's per-file line limit.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const reanchorDaysAgo = (daysAgo: number, now: Date): string =>
  new Date(now.getTime() - daysAgo * MS_PER_DAY).toISOString();

const flagshipStepDefinitionKey = (
  pipeline: DemoFlagshipPipelineFixture,
  stepKey: string,
): string => `${pipeline.key}_${stepKey}`;

/** The fixture as a pipeline document: its step, wait and end nodes. */
export const buildDemoFlagshipPipelineDocument = (
  pipeline: DemoFlagshipPipelineFixture,
): PipelineDocument => ({
  schemaVersion: 1,
  key: pipeline.key,
  title: pipeline.name,
  start: { to: pipeline.entryNodeKey },
  nodes: {
    ...Object.fromEntries(
      pipeline.steps.map((step) => [
        step.key,
        {
          kind: "step" as const,
          title: step.stepName,
          step: flagshipStepDefinitionKey(pipeline, step.key),
          next: step.next,
        },
      ]),
    ),
    ...pipeline.waitNodes,
    ...pipeline.endNodes,
  },
});

/**
 * Ensures the flagship pipeline's step definitions and active version match
 * the fixture. Both flagship work items share this one pipeline; publishing
 * is idempotent by content hash, so whichever seeds second writes nothing.
 */
export const ensureDemoFlagshipPipelineDefinition = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  pipeline: DemoFlagshipPipelineFixture,
): Promise<UuidV7> => {
  await ensureDemoStepDefinitions(
    appContext,
    projectId,
    userAuthz,
    pipeline.steps.map((step) => ({
      key: flagshipStepDefinitionKey(pipeline, step.key),
      name: step.stepName,
      description: pipeline.description,
      prompt: step.stepPrompt,
    })),
  );
  return await ensureDemoPipelineDocument(appContext, projectId, userAuthz, {
    name: pipeline.name,
    document: buildDemoFlagshipPipelineDocument(pipeline),
  });
};

export const ensureDemoFlagshipWorkItem = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  workItem: EnsureDemoFlagshipExecutionInput["workItem"],
): Promise<UuidV7> => {
  const upserted = await upsertWorkItem(
    {
      projectId,
      platform: "scarn",
      platformId: workItem.platformKey,
      platformKey: workItem.platformKey,
      url: null,
      title: workItem.title,
      description: workItem.description,
      sourceCreatedAt: null,
      sourceUpdatedAt: reanchorDaysAgo(
        workItem.daysAgo,
        appContext.timeProvider.now(),
      ),
      // A flagship always replays a real run that ran to completion.
      state: "closed",
      fields: {},
    },
    {
      userAuthz,
      workItemRepo: appContext.workItemRepo,
      workItemBlockRepo: appContext.workItemBlockRepo,
      workItemEvents: appContext.workItemEvents,
      timeProvider: appContext.timeProvider,
    },
  );
  return parseUuidV7(upserted.id);
};
