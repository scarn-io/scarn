import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  claimTaskRunsInputSchema,
  type ClaimTaskRunsInput,
  type TaskRunClaimContract,
} from "../contracts/task-run-contracts";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import { syncTaskWithRun } from "@scarn/core/tasks/task/application/on-run-ended";
import type { TaskRunRepo } from "./task-run-repo";
import { taskRunEntityToContract } from "./task-run-contract-mapper";
import type { TerminalTaskRunHandlers } from "./fail-terminal-task-runs";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { LogFeedConnectionConfig } from "@scarn/core/tasks/task-log/application/log-feed-store";
import { buildLogFeedToken } from "@scarn/core/tasks/task-log/application/issue-log-feed-token";

/**
 * Small, fixed pad on top of `batchSize` for the select that finds timed-out
 * and abandoned Tasks, so rows at the front of the queue are seen before they
 * would otherwise be claimed.
 */
const CLAIMABLE_DETECTION_PAD = 5;

/**
 * Claims up to `batchSize` queued Tasks for a worker; their Tasks become
 * `running`. Before claiming, it
 * fails the Tasks it sees that ran past their deadline (`timeout`) or whose
 * worker stopped heartbeating (`abandoned`), through `terminalTaskHandlers`
 * so the pipeline side can advance their runs. Runs are claimed and their
 * Tasks synced in one transaction, so a chat deleted mid-claim either loses
 * the race outright or waits until the claim commits. Each claim carries a write
 * token for the run's live log feed when `logFeedConnection` is set and the
 * project has an org.
 */
export const claimTaskRuns = async (
  input: ClaimTaskRunsInput,
  {
    userAuthz,
    taskRunRepo,
    taskRepo,
    orgRepo,
    timeProvider,
    terminalTaskHandlers: handlers,
    logFeedConnection,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    taskRepo: TaskRepo;
    orgRepo: Pick<OrgRepo, "findByProjectId">;
    timeProvider: TimeProvider;
    terminalTaskHandlers: TerminalTaskRunHandlers;
    logFeedConnection: LogFeedConnectionConfig | null;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<TaskRunClaimContract[]> => {
  const parsedInput = claimTaskRunsInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId: parsedInput.projectId,
    permission: "executions:write",
  });
  const now = timeProvider.now();

  const candidates = await taskRunRepo.loadClaimableByProjectId(
    parsedInput.projectId,
    parsedInput.batchSize + CLAIMABLE_DETECTION_PAD,
    now,
    dbExecutor,
    parsedInput.workItemId,
  );

  for (const candidate of candidates) {
    if (candidate.status === "timeout") {
      await handlers
        .failTimedOut(candidate.id, dbExecutor)
        .catch(() => undefined);
    } else if (candidate.status === "abandoned") {
      await handlers
        .failAbandoned(candidate.id, dbExecutor)
        .catch(() => undefined);
    }
  }

  const claimed = await (dbExecutor ?? getDb()).transaction(async (tx) => {
    const runs = await taskRunRepo.claimBatch(
      parsedInput.projectId,
      parsedInput.batchSize,
      now,
      parsedInput.workerId,
      userAuthz.actorId,
      parsedInput.leaseDurationSeconds,
      tx,
      parsedInput.workItemId,
    );
    for (const run of runs) {
      await syncTaskWithRun(run, { taskRepo, taskRunRepo, timeProvider }, tx);
    }
    return runs;
  });

  const withTokens = claimed.flatMap((task) =>
    task.claimToken ? [{ task, claimToken: task.claimToken }] : [],
  );
  const org =
    logFeedConnection && withTokens.length > 0
      ? await orgRepo.findByProjectId(parsedInput.projectId, dbExecutor)
      : null;
  return Promise.all(
    withTokens.map(async ({ task, claimToken }) => ({
      task: taskRunEntityToContract(task),
      claimToken,
      logFeed:
        logFeedConnection && org
          ? await buildLogFeedToken(task, org.id, "write", {
              logFeedConnection,
              timeProvider,
            })
          : null,
    })),
  );
};
