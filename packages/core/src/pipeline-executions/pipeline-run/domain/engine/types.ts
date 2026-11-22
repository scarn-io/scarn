/**
 * Plain-data types for the pure pipeline engine: the run state `decide`
 * reads (an in-memory mirror of the runtime tables), the events it handles
 * and the commands it returns for the transactional layer to apply.
 */
import type {
  JsonObject,
  JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import type { ConditionRecord, MissingArg } from "@scarn/shared-core/pipelines";
import type {
  TaskRunReason,
  TaskRunStatus,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";

export type RunStatus =
  "active" | "waiting" | "succeeded" | "failed" | "cancelled";

export type NodeKind = "step" | "wait" | "succeed" | "fail";

export type VisitStatus =
  "active" | "waiting" | "succeeded" | "failed" | "cancelled" | "superseded";

export type LaneGroupStatus = "open" | "merged" | "failed";

export type LaneStatus =
  "pending" | "active" | "arrived" | "ended" | "failed" | "cancelled";

export type ToleratedFailures = { count: number } | { percent: number };

/** The engine's named error, stored in `error_json` on visits and runs. */
export interface EngineError {
  name: string;
  message: string;
  cause?: JsonValue;
}

/**
 * How a visit was entered. `index` is the route or catch index, 0 for
 * `start`, `otherwise` and `merge` (a merge node entered once its lanes
 * arrived).
 */
export interface VisitTransition {
  kind: "start" | "route" | "otherwise" | "catch" | "merge";
  index: number;
}

export interface CheckedTransition {
  index: number;
  when: ConditionRecord | null;
  matched: boolean;
}

export type RoutingNote =
  | { kind: "branch_ambiguous"; branches: (string | null)[] }
  | { kind: "questions_dropped"; asked: number; dropped: number }
  | { kind: "question_cut"; length: number; limit: number };

/** `routing_json`: the `when` conditions checked, the routes taken (empty: the path ended), and branch notes. */
export interface Routing {
  checked?: CheckedTransition[];
  taken?: VisitTransition[] | null;
  notes?: RoutingNote[];
  /** A person's overrules of `taken`, oldest first. */
  overrules?: RouteOverrule[];
}

/** A person changing which routes a visit took, with a reason. The result stays as it was. */
export interface RouteOverrule {
  /** What was taken before; empty when the path had ended. */
  from: VisitTransition[];
  to: VisitTransition[];
  byUserId: string;
  at: string;
  reason: string;
  /** The args the person accepted as missing. */
  missingArgs: MissingArg[];
}

export interface RunInfo {
  id: string;
  status: RunStatus;
  endNodeId: string | null;
  error: EngineError | null;
  cancelledByUserId: string | null;
  completedAt: string | null;
}

export interface Visit {
  id: string;
  nodeId: string;
  nodeKind: NodeKind;
  laneId: string | null;
  fromVisitId: string | null;
  fromLaneGroupId: string | null;
  transition: VisitTransition;
  routing: Routing | null;
  status: VisitStatus;
  input: JsonObject;
  /** A step visit's Task, set when its first run is queued; null for other visits. */
  taskId: string | null;
  resultTaskId: string | null;
  result: JsonValue | null;
  error: EngineError | null;
  createdByUserId: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  /** The step visit's conversation: its Task's (`tasks.conversation_id`), read-only. */
  conversationId: string | null;
}

export interface LaneGroup {
  id: string;
  /** `each`: one lane per item; `all`: one lane per route taken by a `match: "all"` node. */
  kind: "each" | "all";
  parentLaneId: string | null;
  spawnedByVisitId: string;
  /** How many lanes the split spawned: the denominator for percent `toleratedFailures`. */
  laneCount: number;
  maxConcurrency: number | null;
  toleratedFailures: ToleratedFailures;
  status: LaneGroupStatus;
}

export interface Lane {
  id: string;
  laneGroupId: string;
  /** The lane's position in its group: the item's index, the taken route's position, or the next free index for a continuation lane. */
  index: number;
  /** The item of an item lane; null for `all` and continuation lanes. */
  item: JsonValue | null;
  /** The route that started the lane; `merge` for a continuation lane. */
  route: VisitTransition;
  /** `split`: spawned by the split; `merge`: the continuation of a partial merge. */
  origin: "split" | "merge";
  status: LaneStatus;
  /** The merge node the lane arrived at with a `partial` route; cleared by a rerun. */
  arrivedAtNodeId: string | null;
  /** The args the lane supplied to the merge. */
  arrivalArgs: JsonObject | null;
  /** The visit whose `partial` route arrived; null when a nested merge carried the lane there. */
  arrivedFromVisitId: string | null;
  arrivalTransition: VisitTransition | null;
  /** The merge visit the lane's arrival went into, once the merge fired. */
  mergedIntoVisitId: string | null;
}

/** A change to a lane group. */
export type LaneGroupPatch = Partial<Pick<LaneGroup, "status" | "laneCount">>;

/** A change to a lane; `null` clears an arrival field. */
export type LanePatch = Partial<
  Pick<
    Lane,
    | "status"
    | "arrivedAtNodeId"
    | "arrivalArgs"
    | "arrivedFromVisitId"
    | "arrivalTransition"
    | "mergedIntoVisitId"
  >
>;

/** A run on a step visit's Task; `attemptNumber` is the run's `number` and `taskId` its run id. */
export interface VisitTask {
  visitId: string;
  attemptNumber: number;
  taskId: string;
}

/** The parts of a Task the engine reads. */
export interface TaskInfo {
  id: string;
  status: TaskRunStatus;
  result: JsonValue | null;
  error: JsonValue | null;
  workBranch: string | null;
}

/** Work-item data; `fields` is keyed by form label (the document's `workItemFields` maps alias → label). */
export interface WorkItemData {
  title: string;
  description: string | null;
  fields: Readonly<Record<string, JsonValue>>;
}

export type QuestionStatus = "open" | "answered" | "not_needed";

/** A question comment a wait visit is waiting on (`node_visit_questions`). */
export interface VisitQuestion {
  id: string;
  visitId: string;
  commentId: string;
  status: QuestionStatus;
  answerCommentId: string | null;
  answeredByUserId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RunState {
  run: RunInfo;
  visits: Visit[];
  laneGroups: LaneGroup[];
  lanes: Lane[];
  visitTasks: VisitTask[];
  tasks: TaskInfo[];
  questions: VisitQuestion[];
  workItem: WorkItemData;
}

export type EngineEvent =
  | { type: "start" }
  /**
   * `taskId` is the visit's Task; `taskRunId` the run whose end changed it.
   * `result` is set when a person ended the Task's conversation while it
   * waited: the Task's own result, not its run's.
   */
  | {
      type: "task_succeeded";
      taskId: string;
      taskRunId: string;
      result?: JsonValue;
    }
  /** A timeout or abandoned lease arrives as `error.name` `Scarn.Timeout` / `Scarn.HeartbeatTimeout`. */
  | {
      type: "task_failed";
      taskId: string;
      taskRunId: string;
      error?: { name?: string; message?: string; cause?: JsonValue };
    }
  /** The agent ended its turn and handed the conversation to a person; `message` is its final message. */
  | { type: "task_waiting"; taskId: string; taskRunId: string; message: string }
  | { type: "task_cancelled"; taskId: string; taskRunId: string }
  /** A person's reply resumed the waiting Task; `taskRunId` is the continuation it queued. */
  | { type: "task_resumed"; taskId: string; taskRunId: string }
  /**
   * The step visit's first run created no Task: its step's concurrency group
   * on the work item was full. The visit fails with `error`.
   */
  | {
      type: "task_dropped";
      visitId: string;
      error: { name: string; message: string; cause?: JsonValue };
    }
  /** A person chose `action` on a waiting decision visit; `body` is their text, already trimmed (null when empty). */
  | {
      type: "decision_made";
      visitId: string;
      action: string;
      body: string | null;
      userId: string;
    }
  | {
      type: "question_answered";
      questionId: string;
      userId: string;
      /** null: continue without reply. */
      answer: { commentId: string; body: string } | null;
    }
  | { type: "rerun_from"; visitId: string; userId: string; message?: string }
  /** A person changed which routes a succeeded step visit took. */
  | {
      type: "route_overruled";
      visitId: string;
      /** The full set of routes to take. Exactly one for `match: "first"`. */
      routes: VisitTransition[];
      reason: string;
      userId: string;
      /** "accept": take routes with missing args; "reject": refuse them; "reject_code_step": refuse because a target is a code step. */
      missingArgs: "accept" | "reject" | "reject_code_step";
    }
  | { type: "cancel"; userId: string | null };

/** A TaskRun to insert on its visit's Task; the visit's first run creates the Task. */
export interface QueuedTask {
  id: string;
  /** The visit's Task; a new id when this is the visit's first run. */
  taskId: string;
  visitId: string;
  attemptNumber: number;
  reason: TaskRunReason;
  stepKey: string;
  input: JsonObject;
  previousTaskId: string | null;
  baseBranch: string | null;
  executionTimeoutSeconds: number | null;
  heartbeatSeconds: number | null;
  message: string | null;
}

export type VisitPatch = Partial<
  Pick<
    Visit,
    | "status"
    | "routing"
    | "resultTaskId"
    | "result"
    | "error"
    | "resolvedByUserId"
    | "resolvedAt"
    | "completedAt"
  >
>;

export type RunPatch = Partial<Omit<RunInfo, "id">>;

export type QuestionPatch =
  | {
      status: "answered";
      answerCommentId: string | null;
      answeredByUserId: string;
      resolvedAt: string;
    }
  | { status: "not_needed"; resolvedAt: string };

/**
 * One write. Commands are ordered so that applying them in sequence never
 * inserts a row before the rows it refers to.
 */
export type Command =
  | { type: "createVisit"; visit: Visit }
  | { type: "updateVisit"; visitId: string; patch: VisitPatch }
  | { type: "createLaneGroup"; group: LaneGroup; lanes: Lane[] }
  | { type: "updateLaneGroup"; groupId: string; patch: LaneGroupPatch }
  | { type: "createLane"; lane: Lane }
  | { type: "updateLane"; laneId: string; patch: LanePatch }
  | { type: "queueTask"; task: QueuedTask }
  | { type: "cancelTask"; taskId: string }
  | {
      type: "askQuestion";
      questionId: string;
      commentId: string;
      visitId: string;
      body: string;
    }
  | { type: "updateQuestion"; questionId: string; patch: QuestionPatch }
  | { type: "updateRun"; patch: RunPatch };

export interface DecideOptions {
  newId: () => string;
  /** ISO timestamp used for `created_at`, `completed_at` and `resolved_at`. */
  now: string;
}

/**
 * Why `decide` ignored an event. `stale`: it refers to something that has
 * moved on (a late or superseded Task, a finished run). `not_waiting`: the
 * visit or question isn't waiting for this event. `invalid_decision`: the
 * decision names an unknown action or leaves out a required body.
 */
export type IgnoredKind = "stale" | "not_waiting" | "invalid_decision";

export interface Ignored {
  kind: IgnoredKind;
  message: string;
}

export const ignore = (kind: IgnoredKind, message: string): Ignored => ({
  kind,
  message,
});

export interface DecideResult {
  commands: Command[];
  /** Set when the event was a no-op, e.g. a late result for a superseded or cancelled visit. */
  ignored?: Ignored;
}

export class DecideError extends Error {
  constructor(
    readonly code:
      | "already_started"
      | "unknown_visit"
      | "invalid_visit_state"
      | "run_not_active"
      | "route_not_overridable"
      | "unknown_route"
      | "route_unchanged"
      | "route_set_invalid"
      | "route_unsupported"
      | "route_args_missing",
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DecideError";
  }
}

export const ENGINE_ERRORS = {
  stepFailed: "Scarn.StepFailed",
  healthCheckFailed: "Scarn.HealthCheckFailed",
  timeout: "Scarn.Timeout",
  heartbeatTimeout: "Scarn.HeartbeatTimeout",
  maxRunsExceeded: "Scarn.MaxRunsExceeded",
  maxTurnsExceeded: "Scarn.MaxTurnsExceeded",
  concurrencyGroupFull: "Scarn.ConcurrencyGroupFull",
  conditionError: "Scarn.ConditionError",
  argsError: "Scarn.ArgsError",
  lanesFailed: "Scarn.LanesFailed",
  failed: "Scarn.Failed",
} as const;
