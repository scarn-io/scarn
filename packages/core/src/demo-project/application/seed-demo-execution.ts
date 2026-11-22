import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { AppContext } from "@scarn/core/lib/di";
import { noopAnalytics } from "@scarn/core/lib/analytics/analytics-port";
import { Result } from "@scarn/core/lib/result";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { createPipelineRun } from "@scarn/core/pipeline-executions/pipeline-run/application/create-pipeline-run";
import type { DemoWorkItemOutcome } from "../demo-project-fixtures";
import {
  claimNextDemoStep,
  completeDemoStep,
  type ClaimedDemoStep,
} from "./drive-demo-pipeline-run";
import {
  fabricatedFailedStepContent,
  fabricatedSucceededStepContent,
} from "./seed-demo-fabricated-step-content";

export type EnsureDemoWorkItemExecutionInput = {
  projectId: UuidV7;
  userAuthz: UserAuthorizationService;
  pipelineDefinitionId: UuidV7;
  workItemId: UuidV7;
  stepTitle: string;
  outcome: DemoWorkItemOutcome;
  withToolEvents: boolean;
};

/**
 * Appends a fabricated log burst to an already-claimed task and completes it
 * with the matching result payload, advancing its run.
 */
const completeFabricatedStep = async (
  appContext: AppContext,
  input: {
    userAuthz: UserAuthorizationService;
    claimedStep: ClaimedDemoStep;
    stepTitle: string;
    outcome: "succeeded" | "failed";
    withToolEvents: boolean;
  },
): Promise<void> => {
  const { claim, stepKey } = input.claimedStep;
  const now = appContext.timeProvider.now();

  const content =
    input.outcome === "succeeded"
      ? fabricatedSucceededStepContent({
          stepKey,
          stepTitle: input.stepTitle,
          now,
          withToolEvents: input.withToolEvents,
        })
      : fabricatedFailedStepContent({
          stepTitle: input.stepTitle,
          now,
          withToolEvents: input.withToolEvents,
        });

  await appContext.logFeedStore.append(
    parseUuidV7(claim.task.id),
    content.logLines,
  );

  await completeDemoStep(appContext, input.userAuthz, input.claimedStep, {
    status: input.outcome,
    resultJson: content.resultJson,
    errorJson: content.errorJson,
  });
};

/**
 * Idempotently drives one work item's pipeline execution to the state its
 * fixture asks for, one step at a time until the pipeline stops producing
 * queued step runs.
 *
 * The loop is deliberately step-count-agnostic: the pipeline document decides
 * which step is queued next, exactly as in a real run.
 *
 * `failed` stops after the first step by construction: a failed step with no
 * `catch` fails the whole run, so no further task is ever queued.
 *
 * `queued` stops even earlier: the execution and its first step run are
 * created, but that step run is deliberately left unclaimed, so the loop
 * below never even starts. See the `queued` case in `DemoWorkItemOutcome`'s
 * doc comment for why this is stable rather than drifting like a claimed
 * "running" step would.
 *
 * Idempotency: `notStarted` never creates an execution. For every other
 * outcome, an existing execution against this `(workItemId,
 * pipelineDefinitionId)` pair means a prior run already seeded this
 * work item — the whole lifecycle (create → claim → log/artifact → complete)
 * is skipped rather than re-driven, since tasks have no natural
 * upsert key of their own. Re-seeding after a fixture change goes through
 * `seed:demo-project:reset` (`reset-demo-executions.ts`).
 */
export const ensureDemoWorkItemExecution = async (
  appContext: AppContext,
  input: EnsureDemoWorkItemExecutionInput,
): Promise<void> => {
  if (input.outcome === "notStarted") {
    return;
  }

  const existing =
    await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
      // Same underlying uuid v7 string as `input.workItemId`; the repo's domain
      // layer uses the `WorkItemId` brand, the application boundary above (and
      // `createPipelineRun`'s input) uses plain `UuidV7`.
      parseWorkItemId(input.workItemId),
      input.pipelineDefinitionId,
    );
  if (existing.length > 0) {
    return;
  }

  const executionResult = await createPipelineRun(
    {
      projectId: input.projectId,
      workItemId: input.workItemId,
      pipelineDefinitionId: input.pipelineDefinitionId,
    },
    {
      ...appContext,
      analytics: noopAnalytics,
      userAuthz: input.userAuthz,
      triggeredBy: "system",
    },
  );
  const execution = Result.unwrap(executionResult);

  if (input.outcome === "queued") {
    return;
  }

  const claimNext = async () =>
    await claimNextDemoStep(appContext, {
      projectId: input.projectId,
      userAuthz: input.userAuthz,
      workItemId: input.workItemId,
      pipelineRunId: parseUuidV7(execution.id),
    });

  let claimedStep = await claimNext();
  if (!claimedStep) {
    throw new InvariantViolationError(
      `Newly created run ${execution.id} has no queued first task`,
      "DEMO_SEED_EXECUTION_MISSING_STEP_RUN",
    );
  }

  while (claimedStep) {
    await completeFabricatedStep(appContext, {
      userAuthz: input.userAuthz,
      claimedStep,
      stepTitle: input.stepTitle,
      outcome: input.outcome,
      withToolEvents: input.withToolEvents,
    });

    claimedStep = await claimNext();
  }
};
