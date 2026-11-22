/**
 * A Task is a unit of work: what to do (the instructions) and how it ended.
 * Each attempt at it is a TaskRun (`tasks/task-run`). A pipeline step visit
 * creates one Task; its retries and continuations are more runs of it.
 *
 * The Task's `status` follows its latest run (`followRun`): queued, running,
 * waiting for a person after a yield, or the outcome the run ended with.
 * A Task created on a blocked work item starts `waiting_for_work` with no
 * run; `startReadyWork` gives it one once the item's blockers are closed.
 * A Task whose step's concurrency limit is full starts
 * `waiting_for_concurrency_slot`, also with no run, until `admit` lets it in.
 */
import type {
  AnyJsonObject,
  AnyJsonValue,
} from "@scarn/core/common/contracts/json";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import type {
  TaskRunEntity,
  TaskEntrypoint,
  TaskKind,
  TaskToolCall,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { taskStateForRun } from "./task-state-for-run";
import {
  newTaskRun,
  validTaskPrompt,
  type NewTaskRunProps,
} from "./task-instructions";

import { validTaskSubject } from "./task-subject";
import { maxTurnsExceeded, turnsLeft, validMaxTurns } from "./task-turns";
import { taskGrants, type Grant } from "./grants";
import {
  taskEnvironmentSelection,
  type TaskEnvironmentSelection,
} from "./task-environment-selection";

export type { NewTaskRunProps } from "./task-instructions";

export const taskStatusValues = [
  "waiting_for_concurrency_slot",
  "waiting_for_work",
  "queued",
  "running",
  "waiting_for_person",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof taskStatusValues)[number];

export type TaskEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  /** The work item the Task works on; null for a chat Task, which has a conversation instead. */
  workItemId: UuidV7 | null;
  /** The step definition the instructions were copied from, if any. */
  stepDefinitionId: UuidV7 | null;
  kind: TaskKind;
  name: string | null;
  /** Set for `agent` Tasks only. */
  prompt: string | null;
  /** Set for `code` Tasks only. */
  entrypointJson: TaskEntrypoint | null;
  /** Set for `mcp_tool` Tasks only. */
  toolCallJson: TaskToolCall | null;
  resultSchemaJson: AnyJsonObject | null;
  /** `null` runs on the repo's own config. */
  taskExecutionConfigId: UuidV7 | null;
  /** The extra connectors the Task adds; `null` when it adds none. */
  environmentSelection: TaskEnvironmentSelection | null;
  inputJson: AnyJsonValue | null;
  /**
   * The Task's retry policy (`retryDecision`): the pipeline node's `retry`
   * list, copied when a step visit creates the Task, or the step
   * definition's for a standalone Task.
   */
  retryJson: AnyJsonValue | null;
  /** The step definition's grants when the Task was created, plus `read` on `self`; none for a Task without a work item (`taskGrants`). */
  grants: readonly Grant[];
  /**
   * How many times the agent may hand over: the pipeline node's `maxTurns`,
   * copied when a step visit creates the Task, or for a standalone Task its
   * step definition's (else `DEFAULT_STANDALONE_MAX_TURNS`), raised by
   * `grantTurn` when a person replies with none left.
   */
  maxTurns: number | null;
  /** When set, the lease a claim or heartbeat grants is this long. */
  heartbeatSeconds: number | null;
  executionTimeoutSeconds: number | null;
  status: TaskStatus;
  resultJson: AnyJsonValue | null;
  errorJson: AnyJsonValue | null;
  startedByUserId: UuidV7 | null;
  /** The automation that started the Task, or its pipeline run. */
  startedByAutomationId: UuidV7 | null;
  previousTaskId: UuidV7 | null;
  /** The Task's conversation, set when its agent first hands over. */
  conversationId: UuidV7 | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateTaskEntityProps = Omit<
  TaskEntityProps,
  | "id"
  | "stepDefinitionId"
  | "name"
  | "prompt"
  | "entrypointJson"
  | "toolCallJson"
  | "resultSchemaJson"
  | "taskExecutionConfigId"
  | "environmentSelection"
  | "inputJson"
  | "retryJson"
  | "grants"
  | "maxTurns"
  | "heartbeatSeconds"
  | "executionTimeoutSeconds"
  | "resultJson"
  | "errorJson"
  | "startedByUserId"
  | "startedByAutomationId"
  | "previousTaskId"
  | "conversationId"
  | "updatedAt"
> &
  Partial<
    Pick<
      TaskEntityProps,
      | "id"
      | "stepDefinitionId"
      | "name"
      | "prompt"
      | "entrypointJson"
      | "toolCallJson"
      | "resultSchemaJson"
      | "taskExecutionConfigId"
      | "environmentSelection"
      | "inputJson"
      | "retryJson"
      | "grants"
      | "maxTurns"
      | "heartbeatSeconds"
      | "executionTimeoutSeconds"
      | "startedByUserId"
      | "startedByAutomationId"
      | "previousTaskId"
      | "conversationId"
      | "updatedAt"
    >
  >;

const positiveIntegerOrNull = (
  value: number | null,
  field: string,
  code: string,
): number | null => {
  if (value !== null && (!Number.isInteger(value) || value <= 0)) {
    throw new CoreValidationError(
      `Task ${field} must be a positive integer`,
      code,
    );
  }
  return value;
};

export class TaskEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly workItemId: UuidV7 | null;
  public readonly stepDefinitionId: UuidV7 | null;
  public readonly kind: TaskKind;
  public readonly name: string | null;
  public readonly prompt: string | null;
  public readonly entrypointJson: TaskEntrypoint | null;
  public readonly toolCallJson: TaskToolCall | null;
  public readonly resultSchemaJson: AnyJsonObject | null;
  public readonly taskExecutionConfigId: UuidV7 | null;
  public readonly environmentSelection: TaskEnvironmentSelection | null;
  public readonly inputJson: AnyJsonValue | null;
  public readonly retryJson: AnyJsonValue | null;
  public readonly grants: readonly Grant[];
  public readonly maxTurns: number | null;
  public readonly heartbeatSeconds: number | null;
  public readonly executionTimeoutSeconds: number | null;
  public readonly status: TaskStatus;
  public readonly resultJson: AnyJsonValue | null;
  public readonly errorJson: AnyJsonValue | null;
  public readonly startedByUserId: UuidV7 | null;
  public readonly startedByAutomationId: UuidV7 | null;
  public readonly previousTaskId: UuidV7 | null;
  public readonly conversationId: UuidV7 | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: TaskEntityProps) {
    const prompt = validTaskPrompt(props);

    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    const subject = validTaskSubject(props.workItemId, props.conversationId);
    this.workItemId = subject.workItemId;
    this.stepDefinitionId =
      props.stepDefinitionId === null
        ? null
        : parseUuidV7(props.stepDefinitionId);
    this.kind = props.kind;
    this.name = props.name?.trim() || null;
    this.prompt = prompt;
    this.entrypointJson = props.entrypointJson;
    this.toolCallJson = props.toolCallJson;
    this.resultSchemaJson = props.resultSchemaJson;
    this.taskExecutionConfigId =
      props.taskExecutionConfigId === null
        ? null
        : parseUuidV7(props.taskExecutionConfigId);
    this.environmentSelection =
      props.environmentSelection === null
        ? null
        : taskEnvironmentSelection(props.environmentSelection.extraConnectors);
    this.inputJson = props.inputJson;
    this.retryJson = props.retryJson;
    this.grants = props.grants.map((grant) => ({ ...grant }));
    this.maxTurns = validMaxTurns(props.maxTurns);
    this.heartbeatSeconds = positiveIntegerOrNull(
      props.heartbeatSeconds,
      "heartbeatSeconds",
      "TASK_HEARTBEAT_INVALID",
    );
    this.executionTimeoutSeconds = positiveIntegerOrNull(
      props.executionTimeoutSeconds,
      "executionTimeoutSeconds",
      "TASK_TIMEOUT_INVALID",
    );
    this.status = props.status;
    this.resultJson = props.resultJson;
    this.errorJson = props.errorJson;
    this.startedByUserId =
      props.startedByUserId === null
        ? null
        : parseUuidV7(props.startedByUserId);
    this.startedByAutomationId =
      props.startedByAutomationId === null
        ? null
        : parseUuidV7(props.startedByAutomationId);
    this.previousTaskId =
      props.previousTaskId === null ? null : parseUuidV7(props.previousTaskId);
    if (this.previousTaskId === this.id) {
      throw new CoreValidationError(
        "A Task cannot be its own previous Task",
        "TASK_PREVIOUS_TASK_SELF",
      );
    }
    this.conversationId = subject.conversationId;
    this.createdAt = normalizeDate(props.createdAt) ?? new Date(0);
    this.updatedAt = normalizeDate(props.updatedAt) ?? this.createdAt;
  }

  static create(props: CreateTaskEntityProps): TaskEntity {
    return new TaskEntity({
      id: props.id ?? createUuidV7(),
      projectId: props.projectId,
      workItemId: props.workItemId,
      stepDefinitionId: props.stepDefinitionId ?? null,
      kind: props.kind,
      name: props.name ?? null,
      prompt: props.prompt ?? null,
      entrypointJson: props.entrypointJson ?? null,
      toolCallJson: props.toolCallJson ?? null,
      resultSchemaJson: props.resultSchemaJson ?? null,
      taskExecutionConfigId: props.taskExecutionConfigId ?? null,
      environmentSelection: props.environmentSelection ?? null,
      inputJson: props.inputJson ?? null,
      retryJson: props.retryJson ?? null,
      grants: taskGrants(props.grants ?? [], props.workItemId),
      maxTurns: props.maxTurns ?? null,
      heartbeatSeconds: props.heartbeatSeconds ?? null,
      executionTimeoutSeconds: props.executionTimeoutSeconds ?? null,
      status: props.status,
      resultJson: null,
      errorJson: null,
      startedByUserId: props.startedByUserId ?? null,
      startedByAutomationId: props.startedByAutomationId ?? null,
      previousTaskId: props.previousTaskId ?? null,
      conversationId: props.conversationId ?? null,
      createdAt: props.createdAt,
      updatedAt: props.updatedAt ?? props.createdAt,
    });
  }

  static rehydrate(props: TaskEntityProps): TaskEntity {
    return new TaskEntity(props);
  }

  /**
   * This Task in step with `run`, its latest run: `queued` or `running` with
   * it, `waiting_for_person` after a hand-over (a yield), `succeeded` with its
   * result, or
   * `failed` with its error after a failure, timeout or abandoned lease.
   * A yield with no turns left (`continuationRuns` is the Task's continuation
   * runs up to `run`) fails it with `Scarn.MaxTurnsExceeded`. Returns itself
   * when the run changes nothing.
   */
  followRun(run: TaskRunEntity, now: Date, continuationRuns = 0): TaskEntity {
    if (run.taskId !== this.id) {
      throw new CoreValidationError(
        `Run ${run.id} is not a run of Task ${this.id}`,
        "TASK_RUN_TASK_MISMATCH",
      );
    }
    const next =
      run.status === "yielded" && turnsLeft(this, continuationRuns) === 0
        ? maxTurnsExceeded(this.name ?? this.id, this.maxTurns)
        : taskStateForRun(run);
    if (
      next === null ||
      (next.status === this.status &&
        next.resultJson === this.resultJson &&
        next.errorJson === this.errorJson)
    ) {
      return this;
    }
    return new TaskEntity({ ...this.toJSON(), ...next, updatedAt: now });
  }

  /**
   * This Task with one more turn when it has none left after
   * `continuationRuns` (counting the continuation a person's reply queues),
   * so the agent may hand over again. Only standalone Tasks get one; returns
   * itself when turns are left or the Task has no `maxTurns`.
   */
  grantTurn(continuationRuns: number, now: Date): TaskEntity {
    if (this.maxTurns === null || turnsLeft(this, continuationRuns) !== 0) {
      return this;
    }
    return new TaskEntity({
      ...this.toJSON(),
      maxTurns: continuationRuns + 1,
      updatedAt: now,
    });
  }

  /** This Task with `conversationId` as its conversation. */
  withConversation(conversationId: UuidV7, now: Date): TaskEntity {
    return new TaskEntity({ ...this.toJSON(), conversationId, updatedAt: now });
  }

  /**
   * A person ended this Task's conversation: it succeeds with
   * `{ conversationId, summary }`. Only a Task with no result schema ends
   * this way.
   */
  endConversation(summary: string, now: Date): TaskEntity {
    if (this.resultSchemaJson !== null) {
      throw new CoreValidationError(
        "Only a conversation step (one with no result schema) can be ended with Done",
        "CONVERSATION_STEP_HAS_RESULT_SCHEMA",
      );
    }
    return new TaskEntity({
      ...this.toJSON(),
      status: "succeeded",
      resultJson: { conversationId: this.conversationId, summary },
      errorJson: null,
      updatedAt: now,
    });
  }

  /**
   * This Task let in by its step's concurrency group: `queued` with run #1
   * (`initial`, starting from `baseBranch`), or `waiting_for_work` with no
   * run when its work item is blocked, so `startReadyWork` queues the run
   * later.
   */
  admit(props: {
    blocked: boolean;
    baseBranch?: string | null | undefined;
    now: Date;
    runId?: UuidV7 | undefined;
  }): {
    task: TaskEntity;
    run: TaskRunEntity | null;
  } {
    if (this.status !== "waiting_for_concurrency_slot") {
      throw new CoreValidationError(
        `Task ${this.id} is ${this.status}, not waiting for a concurrency slot`,
        "TASK_NOT_WAITING_FOR_CONCURRENCY_SLOT",
      );
    }
    const task = new TaskEntity({
      ...this.toJSON(),
      status: props.blocked ? "waiting_for_work" : "queued",
      updatedAt: props.now,
    });
    const run = props.blocked
      ? null
      : task.newRun({
          id: props.runId,
          number: 1,
          reason: "initial",
          status: "queued",
          baseBranch: props.baseBranch,
          now: props.now,
        });
    return { task, run };
  }

  /**
   * This Task cancelled while it waited (for a person, for work or for a
   * concurrency slot), with no run to cancel.
   */
  cancelWaiting(now: Date): TaskEntity {
    const waiting: readonly TaskStatus[] = [
      "waiting_for_person",
      "waiting_for_work",
      "waiting_for_concurrency_slot",
    ];
    return !waiting.includes(this.status)
      ? this
      : new TaskEntity({
          ...this.toJSON(),
          status: "cancelled",
          resultJson: null,
          errorJson: null,
          updatedAt: now,
        });
  }

  /** A new run of this Task, carrying the Task's instructions read-only. */
  newRun(props: NewTaskRunProps): TaskRunEntity {
    return newTaskRun(this, props);
  }

  toJSON(): TaskEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      workItemId: this.workItemId,
      stepDefinitionId: this.stepDefinitionId,
      kind: this.kind,
      name: this.name,
      prompt: this.prompt,
      entrypointJson: this.entrypointJson,
      toolCallJson: this.toolCallJson,
      resultSchemaJson: this.resultSchemaJson,
      taskExecutionConfigId: this.taskExecutionConfigId,
      environmentSelection: this.environmentSelection,
      inputJson: this.inputJson,
      retryJson: this.retryJson,
      grants: this.grants,
      maxTurns: this.maxTurns,
      heartbeatSeconds: this.heartbeatSeconds,
      executionTimeoutSeconds: this.executionTimeoutSeconds,
      status: this.status,
      resultJson: this.resultJson,
      errorJson: this.errorJson,
      startedByUserId: this.startedByUserId,
      startedByAutomationId: this.startedByAutomationId,
      previousTaskId: this.previousTaskId,
      conversationId: this.conversationId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
