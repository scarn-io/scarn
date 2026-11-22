import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { AppContext } from "@scarn/core/lib/di";
import { noopAnalytics } from "@scarn/core/lib/analytics/analytics-port";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { createPipelineRun } from "@scarn/core/pipeline-executions/pipeline-run/application/create-pipeline-run";
import { recordTaskArtifact } from "@scarn/core/tasks/task-artifact/application/record-task-artifact";
import { deriveArtifactObjectKey } from "@scarn/core/tasks/task-artifact/domain/artifact-object-key";
import type { TaskRunClaimContract } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import {
  parseCapturedLogLines,
  reanchorCapturedLogLines,
} from "./replay-captured-log";
import {
  ensureDemoFlagshipPipelineDefinition,
  ensureDemoFlagshipWorkItem,
} from "./ensure-demo-flagship-pipeline-definition";
import { TRIAGE_AND_INVESTIGATE_PIPELINE } from "./triage-and-investigate-pipeline-fixture";
import { claimNextDemoStep, completeDemoStep } from "./drive-demo-pipeline-run";
import type {
  DemoFlagshipStepArtifactFixture,
  DemoFlagshipStepContent,
  EnsureDemoFlagshipExecutionInput,
} from "./demo-flagship-pipeline-types";

export type {
  DemoFlagshipPipelineFixture,
  DemoFlagshipStepArtifactFixture,
  DemoFlagshipStepContent,
  DemoFlagshipStepNodeFixture,
  EnsureDemoFlagshipExecutionInput,
} from "./demo-flagship-pipeline-types";

/**
 * Replays one real captured run of the demo project's flagship pipeline
 * (`triage-and-investigate-pipeline-fixture.ts`) for one work item, rather
 * than fabricating content the way every other demo work item does
 * (`seed-demo-pipeline.ts`/`seed-demo-execution.ts`).
 *
 * Deliberately NOT an extension of `DemoPipelineFixture`/`DemoWorkItemOutcome`
 * — those fabricate each step's logs and results from a template, and the
 * whole point here is that nothing is fabricated. This module owns the generic
 * "create the run, then claim/replay/complete every step the pipeline queues"
 * mechanics; each flagship (see `seed-demo-coupon-double-apply-flagship.ts`)
 * supplies only its own work item and its own captured step content.
 *
 * Which branch a run takes is decided by the pipeline itself: the captured
 * `classify-and-label-impact` result carries a real `routeKey`, that step's
 * `next` routes evaluate it, and only that branch's steps are ever
 * queued. So a flagship registers content for the intake steps plus its own
 * branch, and the loop below simply asks for whatever step key turned up
 * next.
 *
 * Types are in `demo-flagship-pipeline-types.ts`, and pipeline/work-item setup
 * is in `ensure-demo-flagship-pipeline-definition.ts` — both split out purely
 * to stay under the repo's per-file line limit.
 */

/**
 * Writes one step's real captured artifacts (if any) BEFORE completing it —
 * `recordTaskArtifact` requires the claim still be valid. Skipped
 * entirely when no object store is wired (mirrors every other artifact write
 * in this codebase).
 */
const writeStepArtifacts = async (
  appContext: AppContext,
  input: {
    projectId: UuidV7;
    userAuthz: UserAuthorizationService;
    claim: TaskRunClaimContract;
    artifacts: readonly DemoFlagshipStepArtifactFixture[];
  },
): Promise<void> => {
  if (!appContext.objectStore) {
    return;
  }
  for (const artifact of input.artifacts) {
    const objectKey = deriveArtifactObjectKey({
      projectId: input.projectId,
      taskRunId: parseUuidV7(input.claim.task.id),
      relativeStorePath: artifact.relativeStorePath,
    });
    await appContext.objectStore.putObject({
      key: objectKey,
      body: artifact.bytes,
      contentType: artifact.contentType,
    });
    await recordTaskArtifact(
      input.claim.task.id,
      {
        claimToken: input.claim.claimToken,
        objectKey,
        relativeStorePath: artifact.relativeStorePath,
        sizeBytes: artifact.bytes.byteLength,
        contentType: artifact.contentType,
        kind: artifact.kind,
      },
      {
        userAuthz: input.userAuthz,
        taskRunRepo: appContext.taskRunRepo,
        artifactRepo: appContext.artifactRepo,
        objectStorageBucket: appContext.objectStorageBucket,
        orgRepo: appContext.orgRepo,
        timeProvider: appContext.timeProvider,
        domainEventDispatcher: appContext.domainEventDispatcher,
        analytics: noopAnalytics,
        logger: appContext.logger,
      },
    );
  }
};

/** Drives every step the pipeline queues to completion, replaying real content. */
const driveFlagshipExecutionToCompletion = async (
  appContext: AppContext,
  input: {
    projectId: UuidV7;
    userAuthz: UserAuthorizationService;
    workItemId: UuidV7;
    pipelineRunId: UuidV7;
    stepContent: (stepKey: string) => Promise<DemoFlagshipStepContent>;
  },
): Promise<void> => {
  let claimed = await claimNextDemoStep(appContext, input);
  while (claimed) {
    const content = await input.stepContent(claimed.stepKey);
    const now = appContext.timeProvider.now();
    const lines = reanchorCapturedLogLines(
      parseCapturedLogLines(content.rawLogJsonl),
      now,
    );
    await appContext.logFeedStore.append(
      parseUuidV7(claimed.claim.task.id),
      lines,
    );

    if (content.artifacts && content.artifacts.length > 0) {
      await writeStepArtifacts(appContext, {
        projectId: input.projectId,
        userAuthz: input.userAuthz,
        claim: claimed.claim,
        artifacts: content.artifacts,
      });
    }

    await completeDemoStep(appContext, input.userAuthz, claimed, {
      status: "succeeded",
      resultJson: content.resultJson,
      errorJson: null,
    });

    claimed = await claimNextDemoStep(appContext, input);
  }
};

/**
 * Idempotently seeds one flagship work item: ensures the shared flagship
 * pipeline definition exists, creates the execution if it doesn't already
 * exist, and drives every step the pipeline queues — through the intake head,
 * across the real branch decision, and down whichever investigation branch
 * the captured `routeKey` selects.
 *
 * Idempotent the same way `ensureDemoWorkItemExecution` is: an existing
 * execution for `(workItemId, flagshipPipelineId)` means this was already
 * seeded, and the whole thing is skipped. Re-driving after a content edit goes
 * through `resetDemoFlagshipExecutions` first.
 */
export const ensureDemoFlagshipExecution = async (
  appContext: AppContext,
  input: EnsureDemoFlagshipExecutionInput,
): Promise<void> => {
  const workItemId = await ensureDemoFlagshipWorkItem(
    appContext,
    input.projectId,
    input.userAuthz,
    input.workItem,
  );
  const pipelineDefinitionId = await ensureDemoFlagshipPipelineDefinition(
    appContext,
    input.projectId,
    input.userAuthz,
    TRIAGE_AND_INVESTIGATE_PIPELINE,
  );

  const existing =
    await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
      parseWorkItemId(workItemId),
      pipelineDefinitionId,
    );
  if (existing.length > 0) {
    return;
  }

  const executionResult = await createPipelineRun(
    {
      projectId: input.projectId,
      workItemId,
      pipelineDefinitionId,
    },
    {
      ...appContext,
      analytics: noopAnalytics,
      userAuthz: input.userAuthz,
      triggeredBy: "system",
    },
  );
  const execution = Result.unwrap(executionResult);

  await driveFlagshipExecutionToCompletion(appContext, {
    projectId: input.projectId,
    userAuthz: input.userAuthz,
    workItemId,
    pipelineRunId: parseUuidV7(execution.id),
    stepContent: input.stepContent,
  });
};

/**
 * Deletes a flagship's executions, mirroring `reset-demo-executions.ts`'s
 * per-pipeline loop body but for a work item that isn't part of
 * `DEMO_PIPELINE_FIXTURES`. Safe against a fresh environment: a missing work
 * item or pipeline definition is skipped.
 */
export const resetDemoFlagshipExecutions = async (
  appContext: AppContext,
  projectId: UuidV7,
  input: { workItemPlatformKey: string },
): Promise<void> => {
  const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
    projectId,
    "scarn",
    input.workItemPlatformKey,
  );
  if (!workItem) {
    return;
  }

  const handle = await appContext.pipelineGraphRepo.findHandleByKey(
    projectId,
    TRIAGE_AND_INVESTIGATE_PIPELINE.key,
  );
  if (!handle) {
    return;
  }
  const orphanedTaskIds =
    await appContext.pipelineRunRepo.deleteByWorkItemAndPipelineGraphId(
      workItem.id,
      handle.id,
    );
  if (orphanedTaskIds.length > 0) {
    await appContext.taskRepo.deleteMany(orphanedTaskIds);
  }
};
