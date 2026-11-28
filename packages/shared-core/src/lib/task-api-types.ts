import type { Grant } from "@scarn/sdk/definitions/steps";
import type { Artifact } from "./api-types";
import type { ProjectTaskStatus } from "./work-item-api-types";

/**
 * Minimal, nullable-correct mirrors of the Task and Task run response bodies
 * the `tasks` / `task-runs` commands read (see `./api-types.ts` for why this
 * package does not import the generated types). Only the fields the
 * formatters use are typed; `--json` prints the whole body as received.
 */

/** Any JSON value, as the API returns a Task's input, result and error. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const TASK_STATUSES: readonly ProjectTaskStatus[] = [
  "waiting_for_concurrency_slot",
  "waiting_for_work",
  "queued",
  "running",
  "waiting_for_person",
  "succeeded",
  "failed",
  "cancelled",
];

export type TaskKind = "agent" | "code" | "mcp_tool";

export const TASK_KINDS: readonly TaskKind[] = ["agent", "code", "mcp_tool"];

/** Where a Task's instructions came from. */
export type TaskSource =
  | {
      kind: "step_definition";
      stepDefinitionId: string;
      key: string;
      name: string;
      version: number;
    }
  | { kind: "prompt"; promptPreview: string }
  | { kind: "code"; name: string | null }
  | { kind: "mcp_tool"; name: string | null };

export type TaskWorkItemRef = {
  id: string;
  platformKey: string;
  title: string;
};

type StartedByPerson = { userId: string; username: string | null };

/** Who started a Task: a person, an automation, a schedule rule, or the system. */
export type TaskStartedBy =
  | ({ kind: "user" } & StartedByPerson)
  | {
      kind: "automation";
      automationId: string;
      key: string;
      title: string | null;
    }
  | {
      kind: "schedule";
      automationId: string;
      key: string;
      title: string | null;
      schedule: { id: string; key: string; removed: boolean };
      user: StartedByPerson | null;
    }
  | { kind: "system" };

/** One row of `GET /projects/{id}/tasks`. */
export type TaskSummary = {
  id: string;
  kind: TaskKind;
  name: string | null;
  status: ProjectTaskStatus;
  createdAt: string;
  runNumber: number | null;
  durationMs: number | null;
  latest: { kind: "error" | "message" | "log"; text: string } | null;
  workItem: TaskWorkItemRef | null;
  source: TaskSource;
  pipelineRunId: string | null;
  nodeId: string | null;
  startedBy: TaskStartedBy;
  scheduledFor: string | null;
};

/** `GET /projects/{id}/tasks`. */
export type TaskSummaryPage = {
  tasks: TaskSummary[];
  nextCursor: string | null;
  counts: Partial<Record<ProjectTaskStatus, number>>;
};

/** `GET /tasks/{id}`. */
export type TaskDetail = {
  id: string;
  projectId: string;
  workItemId: string | null;
  kind: TaskKind;
  name: string | null;
  taskExecutionConfigId: string | null;
  inputJson: JsonValue;
  maxTurns: number | null;
  status: ProjectTaskStatus;
  resultJson: JsonValue;
  errorJson: JsonValue;
  previousTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  workItem: TaskWorkItemRef | null;
  source: TaskSource;
  pipelineRunId: string | null;
  nodeId: string | null;
  startedBy: TaskStartedBy;
  scheduledFor: string | null;
  waitingOn: { userId: string; username: string | null }[];
  conversationId: string | null;
  /** The work item grants the Task holds: its step's, plus any approved. */
  grants: Grant[];
};

export type TaskGrantRequestStatus =
  "pending" | "decided" | "unanswered" | "withdrawn";

/** One entry of `GET /tasks/{id}/grant-requests`: an agent asking for more
 * access. `approved` is null until decided; `[]` is a deny. */
export type TaskGrantRequest = {
  id: string;
  taskId: string;
  taskRunId: string;
  reason: string;
  requested: Grant[];
  status: TaskGrantRequestStatus;
  approved: Grant[] | null;
  note: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type TaskRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "abandoned"
  | "cancelled"
  | "skipped"
  | "yielded";

/** `GET /task-runs/{id}`, and one entry of `GET /tasks/{id}/runs`. */
export type TaskRunDetail = {
  id: string;
  taskId: string;
  number: number;
  reason: "initial" | "retry" | "continuation";
  workItemId: string | null;
  name: string | null;
  kind: TaskKind;
  previousTaskRunId: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  heartbeatSeconds: number | null;
  status: TaskRunStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  lastHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  executionTimeoutSeconds: number | null;
  executionDeadlineAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resultJson: JsonValue;
  errorJson: JsonValue;
  workBranch: string | null;
  createdFromBranch: string | null;
  sessionRestored: boolean | null;
  createdAt: string;
};

/** One entry of `GET /task-runs/{id}/artifacts`. */
export type TaskRunArtifact = Artifact & { createdAt: string };

/** One entry of `GET /task-runs/{id}/artifact-failures`: an artifact the
 * worker could not upload. */
export type TaskRunArtifactFailure = {
  id: string;
  taskRunId: string;
  relativeStorePath: string;
  attemptedSizeBytes: number;
  kind: Artifact["kind"];
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
  createdAt: string;
};
