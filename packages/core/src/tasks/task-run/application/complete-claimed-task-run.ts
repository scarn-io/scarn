import type { z } from "zod";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  createUserNotificationsFromTaskResult,
  type CreateUserNotificationsDeps,
} from "@scarn/core/notifications/user-notification/application/create-user-notifications-from-task-result";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import type { Logger } from "@scarn/observability/logging";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import type { AnalyticsPort } from "@scarn/core/lib/analytics/analytics-port";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { LogFeedStore } from "@scarn/core/tasks/task-log/application/log-feed-store";
import { finalizeTaskLog } from "@scarn/core/tasks/task-log/application/finalize-task-log";
import {
  onRunEnded,
  type OnRunEndedDeps,
} from "@scarn/core/tasks/task/application/on-run-ended";
import {
  completeClaimedTaskRunInputSchema,
  getTaskRunInputSchema,
  type CompleteClaimedTaskRunInput,
  type GetTaskRunInput,
  type TaskRunContract,
} from "../contracts/task-run-contracts";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { TaskRunRepo } from "./task-run-repo";
import { taskRunEntityToContract } from "./task-run-contract-mapper";
import {
  assertClaimOwnership,
  buildTimedOutTaskRunError,
} from "./task-run-claim-helpers";
import {
  conversationResult,
  endsAsConversation,
} from "@scarn/core/tasks/task/application/on-task-ended";
import type { ApplyWorkItemChangesDeps } from "@scarn/core/tasks/task/application/apply-work-item-changes";
import {
  resolveTaskArtifacts,
  type ResolveTaskArtifactsDeps,
} from "./resolve-task-artifacts";
import { settleWorkItemChanges } from "./settle-work-item-changes";
import {
  assertManagedAuthorityForSeal,
  type AssertManagedAuthorityForSealDeps,
} from "@scarn/core/connections/managed-mcp-connection/application/assert-managed-authority-for-seal";
import { withTaskSessionCleanup } from "./delete-task-sessions";

/** Dependencies needed to flush a completed step's log feed to the durable archive. */
export type FinalizeLogDeps = {
  taskRunRepo: TaskRunRepo;
  logFeedStore?: LogFeedStore | undefined;
  objectStore?: ObjectStore | null | undefined;
  orgRepo?: OrgRepo | undefined;
  usageMeterRepo?: UsageMeterRepo | undefined;
  timeProvider: TimeProvider;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  logger?: Logger | undefined;
};

/**
 * Archive the step's log feed to durable storage as part of the completion
 * (or yield) transaction. Returns whether the log is kept (see
 * `finalizeTaskLog`); with no live feed store wired there is nothing to
 * archive, which counts as kept.
 */
export const finalizeCompletedStepLog = async (
  taskRunId: UuidV7,
  projectId: UuidV7,
  deps: FinalizeLogDeps,
  tx: DbExecutor,
): Promise<boolean> => {
  if (!deps.logFeedStore) {
    return true;
  }
  return await finalizeTaskLog(taskRunId, projectId, {
    taskRunRepo: deps.taskRunRepo,
    logFeedStore: deps.logFeedStore,
    objectStore: deps.objectStore ?? null,
    ...(deps.orgRepo !== undefined ? { orgRepo: deps.orgRepo } : {}),
    ...(deps.usageMeterRepo !== undefined
      ? { usageMeterRepo: deps.usageMeterRepo }
      : {}),
    timeProvider: deps.timeProvider,
    ...(deps.domainEventDispatcher !== undefined
      ? { domainEventDispatcher: deps.domainEventDispatcher }
      : {}),
    logger: deps.logger,
    dbExecutor: tx,
  });
};

export type CompleteClaimedTaskRunDeps = FinalizeLogDeps &
  ResolveTaskArtifactsDeps &
  OnRunEndedDeps &
  ApplyWorkItemChangesDeps &
  AssertManagedAuthorityForSealDeps & {
    userAuthz: UserAuthorizationService;
    notifications: CreateUserNotificationsDeps;
    analytics: AnalyticsPort;
    dbExecutor?: DbExecutor | undefined;
  };

/**
 * Records the outcome a worker reports for a Task it holds the claim on:
 * stores the result, resolves its artifact fields, creates the notifications
 * the result asks for and archives the log, all in one transaction. A Task
 * past its execution deadline is recorded as `timeout` instead. The same
 * path serves standalone and pipeline Tasks; the Task follows the run and
 * `taskOutcomePort` hears of the change in the same transaction.
 *
 * Before anything is settled, the authority fence
 * (`assertManagedAuthorityForSeal`) checks the managed connections the run's
 * launch pinned. When authority moved first, the run fails with
 * `ManagedConnectionAuthorityLost` whatever it reported, applies none of its
 * changes, and still archives its log and ends through `onRunEnded`; when a
 * relayed call is still in flight or a refresh is pending, the completion
 * is refused with a 409 for the worker to retry. A timed-out run is
 * recorded as `timeout` without the fence: it applies nothing either way.
 *
 * A succeeded run's `workItemChanges` apply in the same transaction, after
 * its log is archived (`settleWorkItemChanges`); when the archive isn't
 * written or a change is refused, the run fails with that named error
 * instead, applies nothing, and goes through the Task's retry policy.
 *
 * A succeeded run of a Task with no result schema stores
 * `{ conversationId, summary }`; `onRunEnded` posts the summary and closes
 * the conversation.
 */
export const completeClaimedTaskRun = async (
  taskIdInput: GetTaskRunInput,
  input: CompleteClaimedTaskRunInput,
  deps: CompleteClaimedTaskRunDeps,
): Promise<Result<TaskRunContract, ResourceNotFoundError>> => {
  const { userAuthz, taskRunRepo, timeProvider, analytics, dbExecutor } = deps;
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = completeClaimedTaskRunInputSchema.parse(input);
  const db = dbExecutor ?? getDb();

  const outcome = await withTaskSessionCleanup(deps, (endedTaskSessions) =>
    db.transaction(async (tx) => {
      const task = await taskRunRepo.lock(taskRunId, tx);
      if (!task) {
        return Result.err(new ResourceNotFoundError("Task", taskRunId));
      }
      await userAuthz.requireProjectPermission({
        projectId: task.projectId,
        permission: "executions:write",
      });

      const now = timeProvider.now();
      assertClaimOwnership(task, parsedInput.claimToken, now);

      const isTimedOut =
        task.executionDeadlineAt !== null &&
        task.executionDeadlineAt !== undefined &&
        task.executionDeadlineAt.getTime() <= now.getTime();
      const authorityLoss = isTimedOut
        ? null
        : await assertManagedAuthorityForSeal(task, now, deps, tx);
      const changes = parsedInput.workItemChanges ?? [];
      const settlesChanges =
        !isTimedOut &&
        authorityLoss === null &&
        parsedInput.status === "succeeded" &&
        changes.length > 0;
      const refusal = settlesChanges
        ? await settleWorkItemChanges(
            task,
            changes,
            async () =>
              await finalizeCompletedStepLog(task.id, task.projectId, deps, tx),
            deps,
            tx,
          )
        : null;
      const branches = {
        workBranch: parsedInput.workBranch,
        createdFromBranch: parsedInput.createdFromBranch,
        sessionRestored: parsedInput.sessionRestored,
      };
      const failure = authorityLoss ?? refusal;
      const completed = isTimedOut
        ? task.failWith("timeout", buildTimedOutTaskRunError(task, now), now)
        : failure
          ? task.complete("failed", now, {
              resultJson: null,
              errorJson: failure,
              ...branches,
            })
          : task.complete(parsedInput.status, now, {
              resultJson: await reportedResult(task, parsedInput, deps, tx),
              errorJson: parsedInput.errorJson,
              ...branches,
            });
      const saved = await taskRunRepo.save(completed, tx);

      await resolveTaskArtifacts(saved, deps, tx);
      await createUserNotificationsFromTaskResult(
        saved,
        deps.notifications,
        tx,
      );
      if (!settlesChanges) {
        await finalizeCompletedStepLog(saved.id, saved.projectId, deps, tx);
      }
      await onRunEnded(saved, { ...deps, endedTaskSessions }, tx);

      return Result.ok(taskRunEntityToContract(saved));
    }),
  );

  if (outcome.ok) {
    reportInvestigationReport(
      outcome.value,
      parsedInput.resultJson,
      userAuthz.actorId,
      analytics,
    );
  }
  return outcome;
};

/** The result `run` stores: the reported one, or `conversationResult` for a Task with no result schema. */
const reportedResult = async (
  run: TaskRunEntity,
  input: z.output<typeof completeClaimedTaskRunInputSchema>,
  deps: CompleteClaimedTaskRunDeps,
  tx: DbExecutor,
): Promise<AnyJsonValue> => {
  if (input.status !== "succeeded" || !endsAsConversation(run)) {
    return input.resultJson;
  }
  const task = await deps.taskRepo.load(run.taskId, tx);
  return task ? conversationResult(task, input.resultJson) : input.resultJson;
};

/**
 * Captures `investigation_report_produced` when a succeeded Task's result
 * carries a non-empty `report` string — the default pipeline's
 * `investigateAndReproduce` output. Sends only booleans derived from the
 * result, never its text. Called after the completion transaction commits.
 */
const reportInvestigationReport = (
  task: TaskRunContract,
  resultJson: AnyJsonValue,
  actorId: UuidV7,
  analytics: AnalyticsPort,
): void => {
  if (
    task.status !== "succeeded" ||
    resultJson === null ||
    typeof resultJson !== "object" ||
    Array.isArray(resultJson)
  ) {
    return;
  }
  const { report, reproduced, tracePath } = resultJson;
  if (typeof report !== "string" || report.trim() === "") {
    return;
  }
  analytics.capture(actorId, AnalyticsEvents.InvestigationReportProduced, {
    project_id: task.projectId,
    task_id: task.id,
    reproduced: reproduced === true,
    has_trace: typeof tracePath === "string" && tracePath.trim() !== "",
  });
};
