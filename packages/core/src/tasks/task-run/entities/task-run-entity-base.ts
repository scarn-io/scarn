import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import type {
  AnyJsonObject,
  AnyJsonValue,
} from "@scarn/core/common/contracts/json";

// `pending` mirrors `taskStatusEnum`'s own schema-level addition
// (see schema.ts) — added here purely so this TS union stays a superset of
// the DB enum (`DrizzleTaskRunRepo` assigns `row.status` directly).
// Nothing in this entity or its callers assigns/interprets `"pending"` yet
// — the `maxConcurrency` promotion mechanism that ever produces it is a
// later phase's job.
export const taskRunStatusValues = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "abandoned",
  "cancelled",
  "skipped",
  "yielded",
] as const;

export type TaskRunStatus = (typeof taskRunStatusValues)[number];

export const taskKindValues = ["agent", "code", "mcp_tool"] as const;

export type TaskKind = (typeof taskKindValues)[number];

/** Why a TaskRun was started: its Task's first run, a retry, or a continuation after a hand-over. */
export const taskRunReasonValues = [
  "initial",
  "retry",
  "continuation",
] as const;

export type TaskRunReason = (typeof taskRunReasonValues)[number];

/** The outcome a worker reports when it completes a Task. */
export const taskRunResultStatusValues = ["succeeded", "failed"] as const;

export type TaskRunResultStatus = (typeof taskRunResultStatusValues)[number];

/** What a worker reports alongside the outcome when it completes a Task. */
export type TaskRunCompletion = {
  resultJson: AnyJsonValue;
  errorJson?: AnyJsonValue | null | undefined;
  workBranch?: string | null | undefined;
  createdFromBranch?: string | null | undefined;
  sessionRestored?: boolean | null | undefined;
};

/**
 * What a worker reports when its agent ends its turn with a yield. `message`
 * is the turn's final text; it is posted to the conversation, not stored on
 * the Task.
 */
export type TaskRunYield = {
  message: string;
  workBranch?: string | null | undefined;
  createdFromBranch?: string | null | undefined;
  sessionObjectKey?: string | null | undefined;
  /** Size in bytes of the exported session, as the worker uploaded it. */
  sessionSizeBytes?: number | null | undefined;
  sessionRestored?: boolean | null | undefined;
};

/**
 * A `kind: "code"` task's portable entrypoint: the module the worker imports
 * from its own checkout to find the step function.
 */
export type TaskEntrypoint = {
  sourceFile: string;
};

/**
 * A `kind: "mcp_tool"` task's tool call, copied from its step definition:
 * the server key in the step's MCP config, the tool's name on it, the args
 * template rendered against the task's input, and the tool's JSON Schemas.
 */
export type TaskToolCall = {
  server: string;
  tool: string;
  argsTemplate: AnyJsonValue;
  toolSchemas: {
    input: AnyJsonObject | boolean;
    output: AnyJsonObject | boolean | null;
  };
};

/**
 * The fields every Task carries regardless of kind. Each leaf class's own
 * props type extends this with the instructions specific to its kind.
 */
export type TaskRunEntityBaseProps = {
  id: UuidV7;
  /** The Task this run is an attempt at. */
  taskId: UuidV7;
  /** 1-based, in the order the Task's runs were started. */
  number: number;
  reason: TaskRunReason;
  projectId: UuidV7;
  /** Null for a run of a chat Task, which has no work item. */
  workItemId: UuidV7 | null;
  /** `null` runs on the repo's own config (D3); shared with the step it came from (D4). */
  taskExecutionConfigId?: UuidV7 | null | undefined;
  /** Copied from the step when the Task is created from one (D5). */
  name?: string | null | undefined;
  resultSchemaJson?: AnyJsonObject | null | undefined;
  /**
   * Read-only, derived by the repo: the Task's run `number - 1`, else the
   * last run of the Task's `previousTaskId`.
   */
  previousTaskRunId?: UuidV7 | null | undefined;
  /** The branch to start from, set by whoever creates the Task. */
  baseBranch?: string | null | undefined;
  /** The full commit object ID the run checks out, copied to later runs. */
  baseCommit?: string | null | undefined;
  /**
   * The named environment version the run uses, pinned when its worker
   * context is first built and copied to later runs.
   */
  environmentVersionId?: UuidV7 | null | undefined;
  /** When set, the lease a claim or heartbeat grants is this long. */
  heartbeatSeconds?: number | null | undefined;
  status: TaskRunStatus;
  /**
   * The instant against which this entity's liveness clocks are evaluated. The
   * derived `status` getter is fixed at this moment for the object's lifetime,
   * so an entity cannot exist without declaring when its status is valid at.
   * Supplied by the repository's `TimeProvider` at the boundary.
   */
  evaluatedAt: Date;
  inputJson?: AnyJsonValue | null | undefined;
  claimedBy?: string | null | undefined;
  /** The user whose credentials claimed the run; cleared with the claim. */
  claimedByUserId?: string | null | undefined;
  claimToken?: string | null | undefined;
  claimedAt?: Date | string | null | undefined;
  lastHeartbeatAt?: Date | string | null | undefined;
  leaseExpiresAt?: Date | string | null | undefined;
  executionTimeoutSeconds?: number | null | undefined;
  executionDeadlineAt?: Date | string | null | undefined;
  startedAt?: Date | string | null | undefined;
  completedAt?: Date | string | null | undefined;
  /** Set on completion and never changed afterwards. */
  resultJson?: AnyJsonValue | null | undefined;
  errorJson?: AnyJsonValue | null | undefined;
  workBranch?: string | null | undefined;
  createdFromBranch?: string | null | undefined;
  /** Object-storage key of the agent session exported on yield. */
  sessionObjectKey?: string | null | undefined;
  /** Size in bytes of that session; null when unknown (saved before metering). */
  sessionSizeBytes?: number | null | undefined;
  /** Whether the worker restored the previous attempt's session. */
  sessionRestored?: boolean | null | undefined;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreateTaskRunEntityBaseProps = Omit<
  TaskRunEntityBaseProps,
  "id"
> & {
  id?: UuidV7 | undefined;
};

/**
 * The flat `tasks` row shape every leaf class's `toJSON()` returns and
 * `TaskRunEntity.rehydrate` (`domain/task-entity.ts`) dispatches on. The
 * table stays one wide table regardless of kind, so the kind-specific
 * instruction columns are nullable here; the leaf classes are where they
 * become required or absent.
 */
export type TaskRunRowProps = TaskRunEntityBaseProps & {
  kind: TaskKind;
  prompt?: string | null | undefined;
  entrypointJson?: TaskEntrypoint | null | undefined;
  toolCallJson?: TaskToolCall | null | undefined;
};

/**
 * Terminal status for a completed task, derived from the reported result
 * status. A task's completion outcome mirrors its result: a succeeded result
 * yields a `succeeded` task, anything else (i.e. `failed`) yields `failed`.
 */
export const taskRunStatusForResult = (
  resultStatus: TaskRunResultStatus,
): Extract<TaskRunStatus, "succeeded" | "failed"> =>
  resultStatus === "succeeded" ? "succeeded" : "failed";

/**
 * Shared base for every `TaskRunEntity` leaf class (see `domain/task-entity.ts`
 * for the union these classes make up): the claim/lease, liveness, status
 * and result lifecycle, which is identical for agent and code tasks.
 * Transitions return `this` so a narrowed `AgentTaskRunEntity` stays an
 * `AgentTaskRunEntity` across `markRunning`/`withStatus`/`complete`.
 */
export abstract class TaskRunEntityBase {
  public abstract readonly kind: TaskKind;
  public readonly id: UuidV7;
  public readonly taskId: UuidV7;
  public readonly number: number;
  public readonly reason: TaskRunReason;
  public readonly projectId: UuidV7;
  public readonly workItemId: UuidV7 | null;
  public readonly taskExecutionConfigId: UuidV7 | null;
  public readonly name: string | null;
  public readonly resultSchemaJson: AnyJsonObject | null;
  public readonly previousTaskRunId: UuidV7 | null;
  public readonly baseBranch: string | null;
  public readonly baseCommit: string | null;
  public readonly environmentVersionId: UuidV7 | null;
  public readonly heartbeatSeconds: number | null;
  /**
   * The literal `task_runs.status` column value. This is the ONLY status
   * the repository persists. The derived, caller-facing status is the `status`
   * getter below; `persistedStatus` must never be exposed as the task's status
   * to a reader that expects liveness applied.
   */
  public readonly persistedStatus: TaskRunStatus;
  public readonly evaluatedAt: Date;
  public readonly inputJson: AnyJsonValue | null;
  public readonly claimedBy: string | null;
  public readonly claimedByUserId: UuidV7 | null;
  public readonly claimToken: string | null;
  public readonly claimedAt: Date | null | undefined;
  public readonly lastHeartbeatAt: Date | null | undefined;
  public readonly leaseExpiresAt: Date | null | undefined;
  public readonly executionTimeoutSeconds: number | null;
  public readonly executionDeadlineAt: Date | null | undefined;
  public readonly startedAt: Date | null | undefined;
  public readonly completedAt: Date | null | undefined;
  public readonly resultJson: AnyJsonValue | null;
  public readonly errorJson: AnyJsonValue | null;
  public readonly workBranch: string | null;
  public readonly createdFromBranch: string | null;
  public readonly sessionObjectKey: string | null;
  public readonly sessionSizeBytes: number | null;
  public readonly sessionRestored: boolean | null;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  protected constructor(props: TaskRunEntityBaseProps) {
    if (
      props.executionTimeoutSeconds !== undefined &&
      props.executionTimeoutSeconds !== null &&
      (!Number.isInteger(props.executionTimeoutSeconds) ||
        props.executionTimeoutSeconds <= 0)
    ) {
      throw new CoreValidationError(
        "Task executionTimeoutSeconds must be a positive integer",
        "TASK_TIMEOUT_INVALID",
      );
    }
    if (
      props.heartbeatSeconds !== undefined &&
      props.heartbeatSeconds !== null &&
      (!Number.isInteger(props.heartbeatSeconds) || props.heartbeatSeconds <= 0)
    ) {
      throw new CoreValidationError(
        "Task heartbeatSeconds must be a positive integer",
        "TASK_HEARTBEAT_INVALID",
      );
    }

    if (!Number.isInteger(props.number) || props.number <= 0) {
      throw new CoreValidationError(
        "TaskRun number must be a positive integer",
        "TASK_RUN_NUMBER_INVALID",
      );
    }

    this.id = parseUuidV7(props.id);
    this.taskId = parseUuidV7(props.taskId);
    this.number = props.number;
    this.reason = props.reason;
    this.projectId = parseUuidV7(props.projectId);
    this.workItemId =
      props.workItemId === null ? null : parseUuidV7(props.workItemId);
    this.taskExecutionConfigId =
      props.taskExecutionConfigId == null
        ? null
        : parseUuidV7(props.taskExecutionConfigId);
    this.name = props.name?.trim() || null;
    this.resultSchemaJson = props.resultSchemaJson ?? null;
    this.previousTaskRunId =
      props.previousTaskRunId == null
        ? null
        : parseUuidV7(props.previousTaskRunId);
    this.baseBranch = props.baseBranch?.trim() || null;
    this.baseCommit = props.baseCommit?.trim() || null;
    this.environmentVersionId =
      props.environmentVersionId == null
        ? null
        : parseUuidV7(props.environmentVersionId);
    this.heartbeatSeconds = props.heartbeatSeconds ?? null;
    this.persistedStatus = props.status;
    this.evaluatedAt = props.evaluatedAt;
    this.inputJson = props.inputJson ?? null;
    this.claimedBy = props.claimedBy?.trim() || null;
    this.claimedByUserId =
      props.claimedByUserId == null ? null : parseUuidV7(props.claimedByUserId);
    this.claimToken = props.claimToken?.trim() || null;
    this.claimedAt = normalizeDate(props.claimedAt);
    this.lastHeartbeatAt = normalizeDate(props.lastHeartbeatAt);
    this.leaseExpiresAt = normalizeDate(props.leaseExpiresAt);
    this.executionTimeoutSeconds = props.executionTimeoutSeconds ?? null;
    this.executionDeadlineAt = normalizeDate(props.executionDeadlineAt);
    this.startedAt = normalizeDate(props.startedAt);
    this.completedAt = normalizeDate(props.completedAt);
    this.resultJson = props.resultJson ?? null;
    this.errorJson = props.errorJson ?? null;
    this.workBranch = props.workBranch?.trim() || null;
    this.createdFromBranch = props.createdFromBranch?.trim() || null;
    this.sessionObjectKey = props.sessionObjectKey?.trim() || null;
    this.sessionSizeBytes = this.sessionObjectKey
      ? (props.sessionSizeBytes ?? null)
      : null;
    this.sessionRestored = props.sessionRestored ?? null;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  /**
   * Rebuilds this leaf class with the given shared fields, carrying over its
   * own kind-specific instructions unchanged.
   */
  protected abstract withBaseProps(props: TaskRunEntityBaseProps): this;

  abstract toJSON(): TaskRunRowProps;

  /**
   * The caller-facing status, deriving `timeout` / `abandoned` from this
   * entity's own clocks against `evaluatedAt`. Timeout wins ties. This is the
   * status every reader should use; `persistedStatus` is the raw column value
   * and only the repository writes it.
   *
   * Any SQL that reads `task_runs.status` directly must apply the same clocks
   * to get the effective status.
   */
  get status(): TaskRunStatus {
    if (this.isTimedOut()) {
      return "timeout";
    }
    if (this.isLeaseExpired()) {
      return "abandoned";
    }
    return this.persistedStatus;
  }

  isLeaseExpired(): boolean {
    return (
      this.persistedStatus === "running" &&
      this.leaseExpiresAt !== null &&
      this.leaseExpiresAt !== undefined &&
      this.leaseExpiresAt.getTime() <= this.evaluatedAt.getTime()
    );
  }

  isTimedOut(): boolean {
    return (
      this.persistedStatus === "running" &&
      this.executionDeadlineAt !== null &&
      this.executionDeadlineAt !== undefined &&
      this.executionDeadlineAt.getTime() <= this.evaluatedAt.getTime()
    );
  }

  markRunning(now: Date): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      status: "running",
      startedAt: this.startedAt ?? now,
      updatedAt: now,
    });
  }

  withStatus(
    status: TaskRunStatus,
    now: Date,
    overrides?: {
      startedAt?: Date | null | undefined;
      completedAt?: Date | null | undefined;
      clearClaim?: boolean | undefined;
    },
  ): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      status,
      claimedBy: overrides?.clearClaim ? null : this.claimedBy,
      claimedByUserId: overrides?.clearClaim ? null : this.claimedByUserId,
      claimToken: overrides?.clearClaim ? null : this.claimToken,
      claimedAt: overrides?.clearClaim ? null : this.claimedAt,
      lastHeartbeatAt: overrides?.clearClaim ? null : this.lastHeartbeatAt,
      leaseExpiresAt: overrides?.clearClaim ? null : this.leaseExpiresAt,
      startedAt: overrides?.startedAt ?? this.startedAt,
      completedAt: overrides?.completedAt ?? this.completedAt,
      updatedAt: now,
    });
  }

  /** True once a worker (or a timeout/abandonment) has recorded the outcome. */
  hasOutcome(): boolean {
    return this.completedAt !== null && this.completedAt !== undefined;
  }

  /**
   * Transition this task to its terminal completed state for the given result
   * status: derive the terminal status, store the reported result, stamp
   * `completedAt`, and release the claim. A completed Task's result never
   * changes afterwards.
   */
  complete(
    resultStatus: TaskRunResultStatus,
    now: Date,
    completion: TaskRunCompletion,
  ): this {
    if (this.hasOutcome()) {
      throw new CoreValidationError(
        "Task already has a result",
        "TASK_RESULT_ALREADY_SET",
      );
    }
    return this.withStatus(taskRunStatusForResult(resultStatus), now, {
      completedAt: now,
      clearClaim: true,
    }).withOutcome(completion, now);
  }

  /**
   * Transition this task to `yielded`: its agent ended its turn and handed the
   * conversation to a person. Like completion it is terminal and releases the
   * claim; the reply starts the Task's next run, a `continuation`.
   */
  yield(now: Date, taskYield: TaskRunYield): this {
    if (this.hasOutcome()) {
      throw new CoreValidationError(
        "Task already has a result",
        "TASK_RESULT_ALREADY_SET",
      );
    }
    return this.withBaseProps({
      ...this.withStatus("yielded", now, {
        completedAt: now,
        clearClaim: true,
      }).baseJSON(),
      workBranch: taskYield.workBranch ?? null,
      createdFromBranch: taskYield.createdFromBranch ?? null,
      sessionObjectKey: taskYield.sessionObjectKey ?? null,
      sessionSizeBytes: taskYield.sessionSizeBytes ?? null,
      sessionRestored: taskYield.sessionRestored ?? null,
      updatedAt: now,
    });
  }

  /**
   * Record a terminal outcome the worker never reported (a timeout or an
   * abandoned lease), with `status` persisted so the liveness overlay is no
   * longer needed.
   */
  failWith(
    status: Extract<TaskRunStatus, "timeout" | "abandoned">,
    errorJson: AnyJsonValue,
    now: Date,
  ): this {
    if (this.hasOutcome()) {
      throw new CoreValidationError(
        "Task already has a result",
        "TASK_RESULT_ALREADY_SET",
      );
    }
    return this.withStatus(status, now, {
      completedAt: now,
      clearClaim: true,
    }).withOutcome({ resultJson: null, errorJson }, now);
  }

  private withOutcome(completion: TaskRunCompletion, now: Date): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      resultJson: completion.resultJson,
      errorJson: completion.errorJson ?? null,
      workBranch: completion.workBranch ?? null,
      createdFromBranch: completion.createdFromBranch ?? null,
      sessionRestored: completion.sessionRestored ?? null,
      updatedAt: now,
    });
  }

  protected baseJSON(): TaskRunEntityBaseProps {
    return {
      id: this.id,
      taskId: this.taskId,
      number: this.number,
      reason: this.reason,
      projectId: this.projectId,
      workItemId: this.workItemId,
      taskExecutionConfigId: this.taskExecutionConfigId,
      name: this.name,
      resultSchemaJson: this.resultSchemaJson,
      previousTaskRunId: this.previousTaskRunId,
      baseBranch: this.baseBranch,
      baseCommit: this.baseCommit,
      environmentVersionId: this.environmentVersionId,
      heartbeatSeconds: this.heartbeatSeconds,
      // The RAW column value, never the derived getter — the transition
      // methods spread this, and re-deriving here would let the overlay
      // leak into a persisted status.
      status: this.persistedStatus,
      evaluatedAt: this.evaluatedAt,
      inputJson: this.inputJson,
      claimedBy: this.claimedBy,
      claimedByUserId: this.claimedByUserId,
      claimToken: this.claimToken,
      claimedAt: this.claimedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      leaseExpiresAt: this.leaseExpiresAt,
      executionTimeoutSeconds: this.executionTimeoutSeconds,
      executionDeadlineAt: this.executionDeadlineAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      resultJson: this.resultJson,
      errorJson: this.errorJson,
      workBranch: this.workBranch,
      createdFromBranch: this.createdFromBranch,
      sessionObjectKey: this.sessionObjectKey,
      sessionSizeBytes: this.sessionSizeBytes,
      sessionRestored: this.sessionRestored,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
