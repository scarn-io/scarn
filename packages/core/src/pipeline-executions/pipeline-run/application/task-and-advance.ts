import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  InvariantViolationError,
  type ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskOutcomePort } from "@scarn/core/tasks/task/application/task-outcome-port";
import type { TaskEntity } from "@scarn/core/tasks/task/domain/task-entity";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import {
  yieldClaimedTaskRunInputSchema,
  type CompleteClaimedTaskRunInput,
  type GetTaskRunInput,
  type TaskRunContract,
  type YieldClaimedTaskRunInput,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import {
  completeClaimedTaskRun,
  type CompleteClaimedTaskRunDeps,
} from "@scarn/core/tasks/task-run/application/complete-claimed-task-run";
import {
  yieldClaimedTaskRun,
  type YieldClaimedTaskRunDeps,
} from "@scarn/core/tasks/task-run/application/yield-claimed-task-run";
import {
  failAbandonedTaskRun,
  failTimedOutTaskRun,
  type FailTerminalTaskRunDeps,
  type TerminalTaskRunHandlers,
} from "@scarn/core/tasks/task-run/application/fail-terminal-task-runs";
import type { JsonValue } from "@scarn/sdk/contracts/pipeline-document";
import type {
  ActedOnTask,
  ActOnTaskDeps,
} from "@scarn/core/tasks/task/application/reply-to-task";
import type { EngineEvent } from "../domain/engine/types";
import {
  loadConversation,
  type ConversationReadDeps,
} from "./get-conversation";
import type { RunCompletion } from "../domain/run-completion";
import {
  advancePipelineRun,
  type AdvanceError,
  type AdvanceOutcome,
  type AdvancePipelineRunDeps,
} from "./advance-pipeline-run";
import {
  deleteTaskSessions,
  type EndedTaskSessions,
  type SessionCleanupDeps,
} from "@scarn/core/tasks/task-run/application/delete-task-sessions";
import {
  reportRunCompletion,
  type RunCompletionReportingDeps,
} from "./report-run-completion";

export type TaskAndAdvanceDeps = AdvancePipelineRunDeps &
  RunCompletionReportingDeps &
  SessionCleanupDeps;

/** The run an operation's outcome advances, and with which event. */
export type AdvanceTarget = { pipelineRunId: UuidV7; event: EngineEvent };

/**
 * Runs `operation` and, when `targetFor` names a run, advances that run in
 * the same transaction; an advance error, or one `verify` returns, is thrown
 * and rolls both back. A run that finished is reported, and the sessions of
 * Tasks that ended are deleted, after the transaction commits, if this call
 * opened it (no `dbExecutor`).
 */
export const withAdvance = async <T, E>(
  operation: (tx: DbExecutor) => Promise<Result<T, E>>,
  targetFor: (value: T, tx: DbExecutor) => Promise<AdvanceTarget | null>,
  deps: TaskAndAdvanceDeps,
  dbExecutor: DbExecutor | undefined,
  verify?: (outcome: AdvanceOutcome) => AdvanceError | null,
): Promise<Result<T, E>> => {
  const db = dbExecutor ?? getDb();
  let completion: RunCompletion | null = null;
  let endedSessionObjectKeys: string[] = [];
  const outcome = await db.transaction(async (tx) => {
    const result = await operation(tx);
    if (!result.ok) {
      return result;
    }
    const target = await targetFor(result.value, tx);
    if (target) {
      const advanced = Result.unwrap(
        await advancePipelineRun(target.pipelineRunId, target.event, deps, tx),
      );
      const rejected = verify?.(advanced);
      if (rejected) {
        throw rejected;
      }
      completion = advanced.completion;
      endedSessionObjectKeys = advanced.endedSessionObjectKeys;
    }
    return result;
  });
  if (!dbExecutor) {
    await reportRunCompletion(completion, deps);
    await deleteTaskSessions(endedSessionObjectKeys, deps);
  }
  return outcome;
};

/** What advances made inside a transaction leave to do after it commits. */
export type TaskOutcomeEffects = {
  completion: RunCompletion | null;
  endedTaskSessions: EndedTaskSessions;
};

export type PipelineTaskOutcomeOptions = {
  /** The yield's final message; the run doesn't store it. */
  yieldMessage?: string | undefined;
};

/** The named error a failed Task stored (see `namedRunError`). */
const taskError = (
  task: TaskEntity,
): { name?: string; message?: string; cause?: JsonValue } => {
  const error = task.errorJson;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return {};
  }
  return {
    ...(typeof error["name"] === "string" ? { name: error["name"] } : {}),
    ...(typeof error["message"] === "string"
      ? { message: error["message"] }
      : {}),
    ...(error["cause"] !== undefined ? { cause: error["cause"] } : {}),
  };
};

/**
 * The engine event for a Task's new status; null when the engine has none.
 * A Task that succeeded without its run succeeding was ended by a person:
 * the visit takes the Task's own result.
 */
const eventForTask = (
  task: TaskEntity,
  run: TaskRunEntity,
  options: PipelineTaskOutcomeOptions,
): EngineEvent | null => {
  const ids = { taskId: task.id, taskRunId: run.id };
  switch (task.status) {
    case "succeeded":
      return run.status === "succeeded"
        ? { type: "task_succeeded", ...ids }
        : { type: "task_succeeded", ...ids, result: task.resultJson };
    case "failed":
      return { type: "task_failed", ...ids, error: taskError(task) };
    case "waiting_for_person":
      if (options.yieldMessage === undefined) {
        throw new InvariantViolationError(
          `Task ${task.id} is waiting without the message its run ${run.id} yielded`,
          "PIPELINE_RUN_YIELD_MESSAGE_MISSING",
        );
      }
      return { type: "task_waiting", ...ids, message: options.yieldMessage };
    case "cancelled":
      return { type: "task_cancelled", ...ids };
    case "waiting_for_concurrency_slot":
    case "waiting_for_work":
    case "queued":
    case "running":
      return null;
  }
};

/**
 * Advances the run whose visit owns the changed Task, in the Task's
 * transaction. A standalone Task belongs to no visit, so nothing advances.
 * `effects` collects what the caller must do once the transaction commits.
 */
export const pipelineTaskOutcomePort = (
  deps: AdvancePipelineRunDeps,
  effects: TaskOutcomeEffects,
  options: PipelineTaskOutcomeOptions = {},
): TaskOutcomePort => {
  const advance = async (
    task: TaskEntity,
    event: EngineEvent | null,
    tx: DbExecutor,
    personAction: boolean,
  ) => {
    const pipelineRunId = event
      ? await deps.pipelineRunRepo.findRunIdByTaskId(task.id, tx)
      : null;
    if (!event || !pipelineRunId) {
      return;
    }
    const advanced = Result.unwrap(
      await advancePipelineRun(pipelineRunId, event, deps, tx),
    );
    if (personAction && advanced.ignored) {
      throw new CoreValidationError(
        `The conversation's step can't go on: ${advanced.ignored.message}`,
        "CONVERSATION_VISIT_NOT_WAITING",
      );
    }
    effects.completion ??= advanced.completion;
    for (const key of advanced.endedSessionObjectKeys) {
      effects.endedTaskSessions.add(key);
    }
  };
  return {
    async taskChanged(task, run, tx) {
      await advance(
        task,
        eventForTask(task, run, options),
        tx,
        task.status === "succeeded" && run.status !== "succeeded",
      );
    },
    async taskResumed(task, run, tx) {
      await advance(
        task,
        { type: "task_resumed", taskId: task.id, taskRunId: run.id },
        tx,
        true,
      );
    },
  };
};

/**
 * Runs a Task operation with `pipelineTaskOutcomePort` in a transaction,
 * collecting the sessions of the Tasks it ends in `endedTaskSessions`. A run
 * that finished is reported, and those sessions are deleted, after it
 * commits, if this call opened it (no `dbExecutor`).
 */
const withTaskOutcome = async <T, E>(
  operation: (
    port: TaskOutcomePort,
    endedTaskSessions: EndedTaskSessions,
    tx: DbExecutor,
  ) => Promise<Result<T, E>>,
  deps: TaskAndAdvanceDeps,
  dbExecutor: DbExecutor | undefined,
  options: PipelineTaskOutcomeOptions = {},
): Promise<Result<T, E>> => {
  const effects: TaskOutcomeEffects = {
    completion: null,
    endedTaskSessions: new Set(),
  };
  const outcome = await (dbExecutor ?? getDb()).transaction((tx) =>
    operation(
      pipelineTaskOutcomePort(deps, effects, options),
      effects.endedTaskSessions,
      tx,
    ),
  );
  if (!dbExecutor) {
    await reportRunCompletion(effects.completion, deps);
    await deleteTaskSessions(effects.endedTaskSessions, deps);
  }
  return outcome;
};

type WithoutPort<T> = Omit<T, "taskOutcomePort">;

/** `completeClaimedTaskRun` with the pipeline port. */
export const completeTaskAndAdvance = async (
  taskIdInput: GetTaskRunInput,
  input: CompleteClaimedTaskRunInput,
  deps: WithoutPort<CompleteClaimedTaskRunDeps> & TaskAndAdvanceDeps,
): Promise<Result<TaskRunContract, ResourceNotFoundError>> =>
  await withTaskOutcome(
    (taskOutcomePort, endedTaskSessions, tx) =>
      completeClaimedTaskRun(taskIdInput, input, {
        ...deps,
        dbExecutor: tx,
        taskOutcomePort,
        endedTaskSessions,
      }),
    deps,
    deps.dbExecutor,
  );

/**
 * A person's action on a Task's conversation (`replyToTask`, `continueTask`
 * or `endTask`) with the pipeline port, which advances the run of the
 * visit that owns the Task. Returns the conversation.
 */
export const actOnTaskAndAdvance = async <I>(
  action: (
    input: I,
    deps: ActOnTaskDeps,
    tx: DbExecutor,
  ) => Promise<Result<ActedOnTask, ResourceNotFoundError>>,
  input: I,
  deps: WithoutPort<ActOnTaskDeps> & TaskAndAdvanceDeps & ConversationReadDeps,
) => {
  const outcome = await withTaskOutcome(
    (taskOutcomePort, endedTaskSessions, tx) =>
      action(input, { ...deps, taskOutcomePort, endedTaskSessions }, tx),
    deps,
    deps.dbExecutor,
  );
  return outcome.ok
    ? await loadConversation(outcome.value.conversationId, deps)
    : outcome;
};

/**
 * `yieldClaimedTaskRun` with the pipeline port, which advances the Task's run
 * with `task_waiting`: it posts the agent's message and makes the visit wait.
 * A yield past the deadline is recorded as `timeout` and advances as one.
 */
export const yieldTaskAndAdvance = async (
  taskIdInput: GetTaskRunInput,
  input: YieldClaimedTaskRunInput,
  deps: WithoutPort<YieldClaimedTaskRunDeps> & TaskAndAdvanceDeps,
): Promise<Result<TaskRunContract, ResourceNotFoundError>> =>
  await withTaskOutcome(
    (taskOutcomePort, endedTaskSessions, tx) =>
      yieldClaimedTaskRun(taskIdInput, input, {
        ...deps,
        dbExecutor: tx,
        taskOutcomePort,
        endedTaskSessions,
      }),
    deps,
    deps.dbExecutor,
    { yieldMessage: yieldClaimedTaskRunInputSchema.parse(input).message },
  );

/** Claim and heartbeat handlers that fail a run with the pipeline port. */
export const pipelineTerminalTaskRunHandlers = (
  deps: WithoutPort<Omit<FailTerminalTaskRunDeps, "dbExecutor">> &
    TaskAndAdvanceDeps,
): TerminalTaskRunHandlers => ({
  failTimedOut: (taskRunId, dbExecutor) =>
    withTaskOutcome(
      (taskOutcomePort, endedTaskSessions, tx) =>
        failTimedOutTaskRun(taskRunId, {
          ...deps,
          dbExecutor: tx,
          taskOutcomePort,
          endedTaskSessions,
        }),
      deps,
      dbExecutor,
    ),
  failAbandoned: (taskRunId, dbExecutor) =>
    withTaskOutcome(
      (taskOutcomePort, endedTaskSessions, tx) =>
        failAbandonedTaskRun(taskRunId, {
          ...deps,
          dbExecutor: tx,
          taskOutcomePort,
          endedTaskSessions,
        }),
      deps,
      dbExecutor,
    ),
});
