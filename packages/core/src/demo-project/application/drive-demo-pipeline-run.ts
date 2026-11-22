import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import { noopAnalytics } from "@scarn/core/lib/analytics/analytics-port";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  completeTaskAndAdvance,
  pipelineTerminalTaskRunHandlers,
} from "@scarn/core/pipeline-executions/pipeline-run/application/task-and-advance";
import { claimTaskRuns } from "@scarn/core/tasks/task-run/application/claim-task-runs";
import type {
  CompleteClaimedTaskRunInput,
  TaskRunClaimContract,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";

const DEMO_SEED_WORKER_ID = "demo-seed-script";

/** One claimed demo task and the node id (the fixture step key) that queued it. */
export type ClaimedDemoStep = {
  claim: TaskRunClaimContract;
  stepKey: string;
};

const advanceDeps = (appContext: AppContext) => ({
  ...appContext,
  analytics: noopAnalytics,
});

/**
 * Claims the next queued task of `pipelineRunId`, or returns null when the
 * run has none left, which is how a drive loop learns the run stopped
 * (succeeded, failed or is waiting). Claims are scoped to the work item, and
 * the seeded run is the work item's only open one.
 */
export const claimNextDemoStep = async (
  appContext: AppContext,
  input: {
    projectId: UuidV7;
    userAuthz: UserAuthorizationService;
    workItemId: UuidV7;
    pipelineRunId: UuidV7;
  },
): Promise<ClaimedDemoStep | null> => {
  const [claim] = await claimTaskRuns(
    {
      projectId: input.projectId,
      workerId: DEMO_SEED_WORKER_ID,
      batchSize: 1,
      workItemId: input.workItemId,
    },
    {
      userAuthz: input.userAuthz,
      taskRunRepo: appContext.taskRunRepo,
      taskRepo: appContext.taskRepo,
      orgRepo: appContext.orgRepo,
      timeProvider: appContext.timeProvider,
      terminalTaskHandlers: pipelineTerminalTaskRunHandlers(
        advanceDeps(appContext),
      ),
      logFeedConnection: null,
    },
  );
  if (!claim) {
    return null;
  }
  const visit = await appContext.pipelineRunRepo.findNodeIdByTaskRunId(
    claim.task.id,
  );
  if (visit?.pipelineRunId !== input.pipelineRunId) {
    throw new InvariantViolationError(
      `Claimed task ${claim.task.id} does not belong to demo run ${input.pipelineRunId}`,
      "DEMO_SEED_CLAIM_OUTSIDE_RUN",
    );
  }
  return { claim, stepKey: visit.nodeId };
};

/** Completes a claimed demo task and advances its run, as a worker report would. */
export const completeDemoStep = async (
  appContext: AppContext,
  userAuthz: UserAuthorizationService,
  claimed: ClaimedDemoStep,
  outcome: Omit<CompleteClaimedTaskRunInput, "claimToken">,
): Promise<void> => {
  Result.unwrap(
    await completeTaskAndAdvance(
      claimed.claim.task.id,
      { ...outcome, claimToken: claimed.claim.claimToken },
      { ...advanceDeps(appContext), userAuthz },
    ),
  );
};
