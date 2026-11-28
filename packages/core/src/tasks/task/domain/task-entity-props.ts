import type {
  AnyJsonObject,
  AnyJsonValue,
} from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  TaskEntrypoint,
  TaskKind,
  TaskToolCall,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { Grant } from "./grants";
import type { GrantRequestsSubject } from "./task-grant-requests";
import type { LogArchive } from "./log-archive";
import type { TaskEnvironmentSelection } from "./task-environment-selection";
import type { WorkItemChange } from "../contracts/work-item-change-contracts";

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
  /** The work item the Task works on; null for a chat Task, which has a conversation instead, and for a scheduled Task. */
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
  /** The step definition's grants when the Task was created, plus `read` on `self`; a scheduled Task keeps only its `project` grants and a chat has none (`taskGrants`). */
  grants: readonly Grant[];
  /**
   * Whether the Task's agent may ask a person for more grants, set when the
   * Task is created; omitted means `false`.
   */
  grantRequests?: boolean | undefined;
  /**
   * Work item changes earlier runs recorded before handing over, applied
   * when the Task succeeds; omitted means none.
   */
  heldWorkItemChanges?: readonly WorkItemChange[] | undefined;
  /**
   * How many times the agent may hand over: the pipeline node's `maxTurns`,
   * copied when a step visit creates the Task, or for a standalone Task its
   * step definition's (else `DEFAULT_STANDALONE_MAX_TURNS`), raised by
   * `grantTurn` when a person replies with none left.
   */
  maxTurns: number | null;
  /**
   * Its step definition's log setting when the Task was created; omitted
   * means `always`. See `shouldArchiveRunLog`.
   */
  logArchive?: LogArchive | undefined;
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
  /** The schedule that started the Task and owns it; a scheduled Task has no work item. */
  startedByScheduleId: UuidV7 | null;
  /** The cron time a scheduled Task runs for. */
  scheduledFor: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The props `TaskEntity.create` may leave out; it defaults them to null (or empty). */
type OptionalOnCreate =
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
  | "startedByScheduleId"
  | "scheduledFor"
  | "updatedAt";

export type CreateTaskEntityProps = Omit<
  TaskEntityProps,
  OptionalOnCreate | "resultJson" | "errorJson"
> &
  Partial<Pick<TaskEntityProps, OptionalOnCreate>> &
  Pick<GrantRequestsSubject, "stepGrantRequests">;
